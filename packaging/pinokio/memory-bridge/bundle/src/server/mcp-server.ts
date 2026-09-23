import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isClientIdentityId } from './client-identity-contract.js';
import { config } from './config.js';
import { answerToolRegistry } from './answer-tools.js';
import {
  type ContextualQueryUnderstandingService,
  untrustedQueryContextTurns,
} from './contextual-query-understanding.js';
import { MemoryStore } from './memory-store.js';
import {
  MEMORY_KINDS,
  type MemoryAccessScope,
  type MemoryListInput,
  type MemoryRecord,
  type MemoryScopeType,
  type MemoryStats,
} from './types.js';

const kindSchema = z.enum(MEMORY_KINDS);
const MEMORY_INTERNAL_REQUEST_KEY = '_memoryRequestKey';
const MAX_RECENT_TOOL_CALLS = 256;
const memoryRequestKeySchema = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe('兼容代理注入的内部请求键，用于合并同一次模型工具调用');
const recentTurnsSchema = z.array(z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(12_000),
  occurredAt: z.string().datetime().optional(),
}).strict()).max(12).optional().describe(
  '仅用于本次查询语义消歧的最近对话；不可信且不能携带身份或 scope',
);

interface CachedToolCall {
  fingerprint: string;
  promise: Promise<unknown>;
}

export interface McpBoundContext {
  readonly principalId: string;
  readonly namespace: string;
  readonly scopes: readonly Readonly<MemoryAccessScope>[];
}

const MEMORY_SCOPE_TYPES = [
  'personal',
  'project',
  'role',
  'session',
] as const satisfies readonly MemoryScopeType[];
const memoryScopeSchema = z.enum(MEMORY_SCOPE_TYPES);
const MCP_MEMORY_NOT_FOUND = '记忆不存在于当前 MCP 连接范围';

function scopeIdentity(scope: Readonly<MemoryAccessScope>): string {
  return `${scope.scopeType}\u0000${scope.scopeKey}`;
}

function normalizeBoundContext(
  input: string | McpBoundContext,
): McpBoundContext {
  const candidate = typeof input === 'string'
    ? {
        principalId: input,
        namespace: config.defaultNamespace,
        scopes: [{ scopeType: 'personal' as const, scopeKey: 'self' }],
      }
    : input;
  const principalId = candidate.principalId.trim();
  const namespace = candidate.namespace.trim();
  if (!principalId) throw new Error('MCP principal 不能为空');
  if (!namespace) throw new Error('MCP namespace 不能为空');
  if (namespace.length > 100) {
    throw new Error('MCP namespace 不能超过 100 个字符');
  }
  if (!Array.isArray(candidate.scopes) || candidate.scopes.length === 0) {
    throw new Error('MCP 可见作用域不能为空');
  }

  const seenTypes = new Set<MemoryScopeType>();
  const normalizedScopes = candidate.scopes.map((scope) => {
    if (!MEMORY_SCOPE_TYPES.includes(scope.scopeType)) {
      throw new Error('MCP 作用域类型无效');
    }
    if (seenTypes.has(scope.scopeType)) {
      throw new Error(`MCP ${scope.scopeType} 作用域不能重复绑定`);
    }
    seenTypes.add(scope.scopeType);
    const scopeKey = scope.scopeKey.trim();
    if (
      scope.scopeType === 'personal'
        ? scopeKey !== 'self'
        : !isClientIdentityId(scopeKey)
    ) {
      throw new Error(`MCP ${scope.scopeType} 作用域 key 无效`);
    }
    return Object.freeze({
      scopeType: scope.scopeType,
      scopeKey,
    });
  });
  if (!normalizedScopes.some(
    (scope) =>
      scope.scopeType === 'personal' && scope.scopeKey === 'self',
  )) {
    throw new Error('MCP 连接必须包含 personal/self 作用域');
  }

  return Object.freeze({
    principalId,
    namespace,
    scopes: Object.freeze(normalizedScopes),
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(
      value as Record<string, unknown>,
    ).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function createToolCallDeduplicator(principalId: string) {
  const cache = new Map<string, CachedToolCall>();

  return async function runToolOnce<T>(
    toolName: string,
    requestKey: string | undefined,
    input: unknown,
    execute: () => T | Promise<T>,
  ): Promise<T> {
    if (!requestKey) return await execute();
    const cacheKey = `${principalId}:${toolName}:${requestKey}`;
    const fingerprint = canonicalJson(input);
    const existing = cache.get(cacheKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(
          '同一个请求键关联了不同的工具参数',
        );
      }
      cache.delete(cacheKey);
      cache.set(cacheKey, existing);
      return (await existing.promise) as T;
    }

    const promise = Promise.resolve().then(execute);
    cache.set(cacheKey, { fingerprint, promise });
    while (cache.size > MAX_RECENT_TOOL_CALLS) {
      const oldest = cache.keys().next().value;
      if (typeof oldest !== 'string') break;
      cache.delete(oldest);
    }
    try {
      return await promise;
    } catch (error) {
      if (cache.get(cacheKey)?.promise === promise) {
        cache.delete(cacheKey);
      }
      throw error;
    }
  };
}

function jsonResult(
  value: unknown,
  metadata?: Record<string, unknown>,
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
    ...(metadata
      ? {
        structuredContent: metadata,
        _meta: metadata,
      }
      : {}),
  };
}

export function createMcpServer(
  store: MemoryStore,
  identity: string | McpBoundContext,
  queryUnderstandingService?: ContextualQueryUnderstandingService,
): McpServer {
  const boundContext = normalizeBoundContext(identity);
  const boundPrincipalId = boundContext.principalId;
  const boundNamespace = boundContext.namespace;
  const boundScopes = boundContext.scopes;
  const scopeByType = new Map(
    boundScopes.map((scope) => [scope.scopeType, scope]),
  );
  const authorizedScopeIds = new Set(boundScopes.map(scopeIdentity));

  const assertBoundNamespace = (namespace: string | undefined): void => {
    if (
      namespace !== undefined &&
      namespace.trim() !== boundNamespace
    ) {
      throw new Error('namespace 不属于当前 MCP 连接');
    }
  };
  const resolveWriteScope = (
    scopeType: MemoryScopeType = 'personal',
  ): Readonly<MemoryAccessScope> => {
    const scope = scopeByType.get(scopeType);
    if (!scope) {
      throw new Error(`${scopeType} 作用域未绑定到当前 MCP 连接`);
    }
    return scope;
  };
  const isVisibleMemory = (memory: MemoryRecord): boolean =>
    memory.namespace === boundNamespace &&
    authorizedScopeIds.has(scopeIdentity(memory));
  const visibleMemoryOrThrow = (id: string): MemoryRecord => {
    const memory = store.get(
      id,
      true,
      boundPrincipalId,
      boundNamespace,
    );
    if (!memory || !isVisibleMemory(memory)) {
      throw new Error(MCP_MEMORY_NOT_FOUND);
    }
    return memory;
  };
  const mutableBoundScopes = (): MemoryAccessScope[] =>
    boundScopes.map(({ scopeType, scopeKey }) => ({ scopeType, scopeKey }));
  const scopedIdempotencyKey = (
    scope: Readonly<MemoryAccessScope>,
    value: string | undefined,
  ): string | undefined => value
    ? `mcp-v2:${createHash('sha256').update(JSON.stringify([
        boundNamespace,
        scope.scopeType,
        scope.scopeKey,
        value,
      ])).digest('hex')}`
    : undefined;
  const listBoundMemories = (
    input: Omit<
      MemoryListInput,
      'userId' | 'namespace' | 'scopeType' | 'scopeKey'
    >,
  ) => {
    const limit = Math.max(1, Math.min(input.limit || 50, 200));
    const offset = Math.max(0, input.offset || 0);
    const targetCount = offset + limit;
    const items: MemoryRecord[] = [];
    let total = 0;
    for (const scope of boundScopes) {
      let scopeOffset = 0;
      let scopeTotal = 0;
      do {
        const page = store.list({
          ...input,
          userId: boundPrincipalId,
          namespace: boundNamespace,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          limit: Math.min(200, Math.max(1, targetCount - scopeOffset)),
          offset: scopeOffset,
        });
        scopeTotal = page.total;
        items.push(...page.items);
        scopeOffset += page.items.length;
        if (page.items.length === 0) break;
      } while (scopeOffset < Math.min(scopeTotal, targetCount));
      total += scopeTotal;
    }
    items.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
    );
    return {
      items: items.slice(offset, targetCount),
      total,
    };
  };
  const scopedStats = (): MemoryStats => {
    const result: MemoryStats = {
      total: 0,
      active: 0,
      archived: 0,
      superseded: 0,
      deleted: 0,
      byKind: {},
      byNamespace: {},
    };
    const statuses = [
      'active',
      'archived',
      'superseded',
      'deleted',
    ] as const;
    for (const scope of boundScopes) {
      for (const status of statuses) {
        const count = store.list({
          userId: boundPrincipalId,
          namespace: boundNamespace,
          scopeType: scope.scopeType,
          scopeKey: scope.scopeKey,
          status,
          limit: 1,
        }).total;
        result[status] += count;
        result.total += count;
      }
      for (const kind of MEMORY_KINDS) {
        let count = 0;
        for (const status of statuses) {
          count += store.list({
            userId: boundPrincipalId,
            namespace: boundNamespace,
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            kind,
            status,
            limit: 1,
          }).total;
        }
        if (count > 0) {
          result.byKind[kind] = (result.byKind[kind] || 0) + count;
        }
      }
    }
    if (result.total > 0) {
      result.byNamespace[boundNamespace] = result.total;
    }
    return result;
  };
  const runToolOnce = createToolCallDeduplicator(boundPrincipalId);
  const server = new McpServer(
    {
      name: 'memory-bridge',
      version: '1.0.0',
      title: '忆桥长期记忆',
      description: '为客户端提供长期记忆写入、召回、更新和遗忘能力。',
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    'memory_remember',
    {
      title: '保存长期记忆',
      description:
        '保存值得跨会话保留的稳定事实、偏好、项目决定、重要事件或指令。不要保存闲聊、临时状态、密码、令牌或未经用户同意的敏感信息。重复内容会自动合并。',
      inputSchema: z.object({
        content: z.string().min(1).describe('完整、独立、脱离上下文也能理解的记忆内容'),
        kind: kindSchema.describe('记忆类型'),
        title: z.string().max(100).optional().describe('简短标题'),
        summary: z.string().max(500).optional().describe('可选摘要'),
        namespace: z
          .string()
          .max(100)
          .optional()
          .describe('兼容字段；只能等于当前 MCP 连接绑定的 namespace'),
        scope: memoryScopeSchema
          .optional()
          .describe('写入当前连接已绑定的 personal、role、project 或 session 作用域'),
        tags: z.array(z.string().max(50)).max(30).optional(),
        importance: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
        source: z.string().max(100).optional(),
        sourceRef: z.string().max(500).optional(),
        occurredAt: z.string().datetime().optional(),
        validFrom: z.string().datetime().optional(),
        validTo: z.string().datetime().optional(),
        supersedesId: z
          .string()
          .uuid()
          .optional()
          .describe('如果新记忆替代旧记忆，填写旧记忆 ID'),
        idempotencyKey: z
          .string()
          .max(200)
          .optional()
          .describe('调用方生成的幂等键，防止重复写入'),
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ _memoryRequestKey, namespace, scope, ...input }) =>
      jsonResult(
        await runToolOnce(
          'memory_remember',
          _memoryRequestKey,
          { ...input, namespace, scope },
          () => {
            assertBoundNamespace(namespace);
            const writeScope = resolveWriteScope(scope);
            if (input.supersedesId) {
              const prior = visibleMemoryOrThrow(input.supersedesId);
              if (scopeIdentity(prior) !== scopeIdentity(writeScope)) {
                throw new Error(MCP_MEMORY_NOT_FOUND);
              }
            }
            // 通道背书由服务端裁定：MCP 认证直写同样是一手内容（origin=api）。
            const remembered = store.remember({
              ...input,
              userId: boundPrincipalId,
              namespace: boundNamespace,
              scopeType: writeScope.scopeType,
              scopeKey: writeScope.scopeKey,
              idempotencyKey: scopedIdempotencyKey(
                writeScope,
                input.idempotencyKey,
              ),
            }, undefined, 'api');
            if (!isVisibleMemory(remembered.memory)) {
              throw new Error(MCP_MEMORY_NOT_FOUND);
            }
            return remembered;
          },
        ),
      ),
  );

  // ── 答案工具（answer_*）：确定性计算，与 HTTP /api/tools
  //    共享同一注册表。用于生成侧把"两数相加、两日期相减"类
  //    运算交给内核做确定性求值，避免 LLM 心算出错。
  server.registerTool(
    'answer_calculator',
    {
      title: '算术计算器',
      description:
        '对算术表达式做确定性求值，支持 + - * / % ^ 与括号。召回结果中的数值需要加减乘除（金额合计、单价×数量等）时调用，不要心算。',
      inputSchema: z.object({
        expression: z.string().min(1).max(256).describe('算术表达式，如 "(1234.5 + 678.9) * 2"'),
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ _memoryRequestKey: _ignored, expression }) =>
      jsonResult(
        await answerToolRegistry.invoke('calculator', { expression }),
      ),
  );

  server.registerTool(
    'answer_date_diff',
    {
      title: '日期差计算',
      description:
        '计算两个日期相差的天数与年/月/日拆分。日期支持 ISO、YYYY/MM/DD、中文（2024年3月5日）。涉及"间隔多少天/多久"的问题时调用。',
      inputSchema: z.object({
        from: z.string().min(4).max(40).describe('起始日期'),
        to: z.string().min(4).max(40).describe('结束日期'),
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ _memoryRequestKey: _ignored, from, to }) =>
      jsonResult(
        await answerToolRegistry.invoke('date_diff', { from, to }),
      ),
  );

  server.registerTool(
    'answer_date_shift',
    {
      title: '日期平移',
      description:
        '把日期平移指定天数（可为负），返回结果日期与星期。"X 天后是几号""提前 N 天"类问题调用。',
      inputSchema: z.object({
        date: z.string().min(4).max(40).describe('基准日期'),
        days: z.number().int().describe('平移天数，可为负数'),
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ _memoryRequestKey: _ignored, date, days }) =>
      jsonResult(
        await answerToolRegistry.invoke('date_shift', { date, days }),
      ),
  );

  server.registerTool(
    'memory_recall',
    {
      title: '召回相关记忆',
      description:
        '回答涉及用户偏好、过去事件、项目状态或既有决定的问题前调用。只返回与当前查询相关的少量长期记忆，并解释命中原因。',
      inputSchema: z.object({
        query: z.string().min(1),
        namespace: z.string().max(100).optional(),
        kinds: z.array(kindSchema).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(30).default(8),
        minScore: z.number().min(0).max(1).default(0.12),
        includeArchived: z.boolean().default(false),
        // bi-temporal as-of：传过去时间可召回当时仍有效、后被取代的历史事实
        timestamp: z.string().max(40).optional(),
        recentTurns: recentTurnsSchema,
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ _memoryRequestKey, recentTurns, namespace, ...input }) => {
      assertBoundNamespace(namespace);
      const recalled = await runToolOnce(
          'memory_recall',
          _memoryRequestKey,
          { ...input, recentTurns, namespace },
          async () => {
            let retrievalTraceId: string | null = null;
            const understandingInput = {
              principalId: boundPrincipalId,
              roundId: _memoryRequestKey,
              originalQuery: input.query,
              recentTurns: untrustedQueryContextTurns(recentTurns),
              currentTime: new Date().toISOString(),
            };
            const queryUnderstanding = queryUnderstandingService
              ? await queryUnderstandingService.understand(
                understandingInput,
              )
              : undefined;
            const value = await store.recallReliable({
              ...input,
              userId: boundPrincipalId,
              namespace: boundNamespace,
              scopes: mutableBoundScopes(),
            }, {
              queryUnderstanding,
              traceContext: _memoryRequestKey
                ? {
                  source: 'mcp',
                  correlationId: _memoryRequestKey,
                }
                : undefined,
              onTraceCreated: (traceId) => {
                retrievalTraceId = traceId;
              },
              qualityFallback: queryUnderstandingService
                ? () => queryUnderstandingService.understand(
                  understandingInput,
                  { forceQualityFallback: true },
                )
                : undefined,
            });
            const trace = retrievalTraceId
              ? store.getRetrievalTrace(
                  retrievalTraceId,
                  boundPrincipalId,
                )
              : null;
            return {
              value,
              retrievalTraceId,
              qualityState: trace?.qualityState || null,
              errorCode: trace?.errorCode || null,
            };
          },
        );
      return jsonResult(
        recalled.value,
        recalled.retrievalTraceId
          ? {
              retrievalTraceId: recalled.retrievalTraceId,
              qualityState: recalled.qualityState,
              errorCode: recalled.errorCode,
            }
          : undefined,
      );
    },
  );

  server.registerTool(
    'memory_get_context',
    {
      title: '生成对话记忆上下文',
      description:
        '在回答用户前检索相关长期记忆，并返回可直接加入模型上下文的紧凑文本。适合每轮对话前调用。',
      inputSchema: z.object({
        query: z.string().min(1),
        namespace: z.string().max(100).optional(),
        kinds: z.array(kindSchema).optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(20).default(8),
        minScore: z.number().min(0).max(1).default(0.12),
        contextTokenBudget:
          z.number().int().min(256).max(8192).optional(),
        recentTurns: recentTurnsSchema,
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ _memoryRequestKey, recentTurns, namespace, ...input }) =>
      jsonResult(
        await runToolOnce(
          'memory_get_context',
          _memoryRequestKey,
          { ...input, recentTurns, namespace },
          async () => {
            assertBoundNamespace(namespace);
            const understandingInput = {
              principalId: boundPrincipalId,
              roundId: _memoryRequestKey,
              originalQuery: input.query,
              recentTurns: untrustedQueryContextTurns(recentTurns),
              currentTime: new Date().toISOString(),
            };
            const queryUnderstanding = queryUnderstandingService
              ? await queryUnderstandingService.understand(
                understandingInput,
              )
              : undefined;
            return await store.getContextReliable({
              ...input,
              userId: boundPrincipalId,
              namespace: boundNamespace,
              scopes: mutableBoundScopes(),
            }, {
              queryUnderstanding,
              traceContext: _memoryRequestKey
                ? {
                  source: 'mcp',
                  correlationId: _memoryRequestKey,
                }
                : undefined,
              qualityFallback: queryUnderstandingService
                ? () => queryUnderstandingService.understand(
                  understandingInput,
                  { forceQualityFallback: true },
                )
                : undefined,
            });
          },
        ),
      ),
  );

  server.registerTool(
    'memory_update',
    {
      title: '修正长期记忆',
      description:
        '修改已经存在但不准确、过期或需要补充的记忆。仅提交需要更改的字段；修改 content 时必须写成修正后的完整、独立事实，不要写“用户修正了”之类的过程描述。',
      inputSchema: z.object({
        id: z.string().uuid(),
        title: z.string().max(100).optional(),
        content: z.string().min(1).optional(),
        summary: z.string().max(500).optional(),
        namespace: z.string().max(100).optional(),
        kind: kindSchema.optional(),
        tags: z.array(z.string().max(50)).max(30).optional(),
        importance: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
        status: z.enum(['active', 'archived', 'superseded']).optional(),
        source: z.string().max(100).optional(),
        sourceRef: z.string().max(500).nullable().optional(),
        occurredAt: z.string().datetime().nullable().optional(),
        validFrom: z.string().datetime().nullable().optional(),
        validTo: z.string().datetime().nullable().optional(),
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, _memoryRequestKey, namespace, ...input }) =>
      jsonResult(
        await runToolOnce(
          'memory_update',
          _memoryRequestKey,
          { id, ...input, namespace },
          () => {
            assertBoundNamespace(namespace);
            const current = visibleMemoryOrThrow(id);
            const updated = store.update(
              id,
              {
                ...input,
                namespace: boundNamespace,
                scopeType: current.scopeType,
                scopeKey: current.scopeKey,
              },
              boundPrincipalId,
            );
            if (!isVisibleMemory(updated)) {
              throw new Error(MCP_MEMORY_NOT_FOUND);
            }
            return updated;
          },
        ),
      ),
  );

  server.registerTool(
    'memory_forget',
    {
      title: '遗忘长期记忆',
      description:
        '根据用户明确要求删除一条记忆。采用可恢复的软删除，并保留审计记录。',
      inputSchema: z.object({
        id: z.string().uuid(),
        reason: z.string().max(300).default('用户请求删除'),
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, reason, _memoryRequestKey }) =>
      jsonResult(
        await runToolOnce(
          'memory_forget',
          _memoryRequestKey,
          { id, reason },
          () => {
            const current = visibleMemoryOrThrow(id);
            if (current.status === 'deleted') return current;
            return store.forget(
              id,
              reason,
              boundPrincipalId,
              {
                expectedNamespace: boundNamespace,
                authorizedScopes: mutableBoundScopes(),
              },
            );
          },
        ),
      ),
  );

  server.registerTool(
    'memory_list',
    {
      title: '列出长期记忆',
      description: '按条件查看记忆，适合管理、核对或让用户确认系统记住了什么。',
      inputSchema: z.object({
        query: z.string().optional(),
        namespace: z.string().max(100).optional(),
        kind: kindSchema.optional(),
        status: z
          .enum(['active', 'superseded', 'archived', 'deleted'])
          .optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ _memoryRequestKey, namespace, ...input }) =>
      jsonResult(
        await runToolOnce(
          'memory_list',
          _memoryRequestKey,
          { ...input, namespace },
          () => {
            assertBoundNamespace(namespace);
            return listBoundMemories(input);
          },
        ),
      ),
  );

  server.registerTool(
    'memory_stats',
    {
      title: '查看记忆库状态',
      description: '查看长期记忆数量、类型和命名空间分布。',
      inputSchema: z.object({
        [MEMORY_INTERNAL_REQUEST_KEY]: memoryRequestKeySchema,
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ _memoryRequestKey }) =>
      jsonResult(
        await runToolOnce(
          'memory_stats',
          _memoryRequestKey,
          {},
          () => ({
            ...scopedStats(),
            userId: boundPrincipalId,
            defaultNamespace: boundNamespace,
            semanticMode: config.semanticMode,
            embeddingModel: config.embeddingModel,
            rerankModel: config.rerankModel,
          }),
        ),
      ),
  );

  return server;
}
