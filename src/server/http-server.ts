import fs from 'node:fs';
import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OLLAMA_COMPAT_PREFIX,
  handleOllamaCompatibilityProxy,
  type ChatLifecycle,
} from './ollama-compat.js';
import { config, parseCompatChatModel } from './config.js';
import { answerToolRegistry } from './answer-tools.js';
import {
  type TrustedSessionRecord,
  type TrustedSessionScope,
  TrustedSessionError,
  TrustedSessionService,
} from './trusted-sessions.js';
import {
  type ContextualQueryUnderstandingService,
  untrustedQueryContextTurns,
} from './contextual-query-understanding.js';
import {
  handleConversationHttp,
} from './conversation-http.js';
import type { ConversationChatEngine } from './conversation-chat.js';
import {
  ConversationService,
  ConversationServiceError,
} from './conversation-service.js';
import {
  IdentityAuthenticationError,
  IdentityBootstrapConflictError,
  IdentityService,
  type AuthenticatedPrincipal,
} from './identity.js';
import {
  MemoryAdminUnavailableError,
  type MemoryActionReviewInput,
  type MemoryAdminService,
} from './memory-admin.js';
import {
  MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
} from './memory-extractor.js';
import {
  MemoryStore,
  type RestoreMemoryInput,
} from './memory-store.js';
import {
  NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
} from './namespace-quality.js';
import type {
  MemoryListInput,
  MemoryScopeType,
  RecallInput,
  RememberInput,
  UpdateMemoryInput,
} from './types.js';
import {
  MemoryReflectionError,
  type MemoryReflectionService,
} from './memory-reflection.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const LOCAL_CHAT_WORKSPACE_PERSONA_ID = 'memory-bridge-local-chat';
const LOCAL_CHAT_WORKSPACE_CLIENT_TYPE = 'memory-bridge-chat';
const LOCAL_CHAT_WORKSPACE_CLIENT_INSTANCE_ID = 'local-workspace';

export interface HttpServerOptions {
  ollamaBaseUrl?: string;
  compatChatModel?: string;
  compatProxyTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  memoryLifecycle?: ChatLifecycle;
  adminService?: MemoryAdminService;
  identityService?: IdentityService;
  reflectionService?: MemoryReflectionService;
  queryUnderstandingService?: ContextualQueryUnderstandingService;
  conversationService?: ConversationService;
  conversationChatEngine?: ConversationChatEngine;
  conversationNamespace?: string;
  trustedSessions?: TrustedSessionService;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  message: string,
  code = errorCode(status, message),
): void {
  sendJson(response, status, { error: message, code });
}

function errorCode(status: number, message: string): string {
  return status === 400
    ? 'INVALID_REQUEST'
    : status === 401
      ? 'UNAUTHORIZED'
      : status === 403
        ? 'FORBIDDEN'
        : status === 404
          ? 'NOT_FOUND'
          : status === 409
            ? 'CONFLICT'
            : status === 503
              ? 'SERVICE_UNAVAILABLE'
              : 'REQUEST_FAILED';
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('请求内容不能超过 5 MB');
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error('请求不是有效的 JSON');
  }
}

function authorized(request: IncomingMessage): boolean {
  if (!config.apiToken) return true;
  const header = request.headers.authorization || '';
  return header === `Bearer ${config.apiToken}`;
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  return (
    request.socket.remoteAddress === '127.0.0.1' ||
    request.socket.remoteAddress === '::1' ||
    request.socket.remoteAddress === '::ffff:127.0.0.1'
  );
}

function requestHeader(
  request: IncomingMessage,
  name: string,
): string | null {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'localhost'
  );
}

function trustedBootstrapBrowserRequest(
  request: IncomingMessage,
): boolean {
  const fetchSite = requestHeader(request, 'sec-fetch-site');
  if (
    fetchSite &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'none'
  ) {
    return false;
  }

  const origin = requestHeader(request, 'origin');
  if (!origin) return true;
  const host = requestHeader(request, 'host');
  if (!host) return false;
  try {
    const originUrl = new URL(origin);
    const requestOrigin = new URL(`http://${host}`);
    return (
      originUrl.protocol === 'http:' &&
      loopbackHostname(originUrl.hostname) &&
      originUrl.origin === requestOrigin.origin
    );
  } catch {
    return false;
  }
}

function bootstrapUsesJson(request: IncomingMessage): boolean {
  const contentType = requestHeader(request, 'content-type');
  return contentType?.split(';', 1)[0].trim().toLowerCase() ===
    'application/json';
}

function bootstrapLocalChatWorkspace(
  options: HttpServerOptions,
  principal: AuthenticatedPrincipal,
): {
  readonly persona: ReturnType<IdentityService['bindPersona']>;
  readonly profile: ReturnType<ConversationService['getChatProfile']>;
} {
  if (!options.identityService || !options.conversationService) {
    throw new Error('本地聊天工作台未配置');
  }
  const persona = options.identityService.bindPersona(principal, {
    clientType: LOCAL_CHAT_WORKSPACE_CLIENT_TYPE,
    clientInstanceId: LOCAL_CHAT_WORKSPACE_CLIENT_INSTANCE_ID,
    personaId: LOCAL_CHAT_WORKSPACE_PERSONA_ID,
    displayName: '本地助手',
  });
  const tenant = {
    principalId: principal.principalId,
    namespace: options.conversationNamespace ?? 'chat',
  };
  try {
    return {
      persona,
      profile: options.conversationService.getChatProfile(
        tenant,
        LOCAL_CHAT_WORKSPACE_PERSONA_ID,
      ),
    };
  } catch (error) {
    if (
      !(error instanceof ConversationServiceError) ||
      error.code !== 'PERSONA_PROFILE_NOT_FOUND'
    ) {
      throw error;
    }
  }
  return {
    persona,
    profile: options.conversationService.putChatProfile(
      tenant,
      LOCAL_CHAT_WORKSPACE_PERSONA_ID,
      {
        expectedVersion: 0,
        displayName: '本地助手',
        systemPrompt:
          '你是运行在用户本机的 Qwen 助手。准确、自然地帮助用户。' +
          '系统可能提供受权限控制的长期记忆作为辅助事实；没有可靠依据时不要捏造个人信息。',
        greeting: '本地助手已就绪。',
        language: 'zh-Hans',
        capabilityIds: [],
      },
    ),
  };
}

/** 匿名公开通道（多租户 v2 / R3）的虚拟主体：仅可召回，仅 public。 */
const ANONYMOUS_PRINCIPAL_ID = '@anonymous';

function authenticateRequest(
  request: IncomingMessage,
  options: HttpServerOptions,
): AuthenticatedPrincipal {
  if (options.identityService) {
    try {
      return options.identityService.authenticateAuthorizationHeader(
        request.headers.authorization,
        isLoopbackRequest(request),
      );
    } catch (error) {
      // 匿名公开通道：显式开启（MEMORY_BRIDGE_ANONYMOUS_MODE=public-readonly）
      // 且请求来自 loopback 时，无令牌请求映射为 @anonymous 虚拟主体；
      // 后续端点白名单将其限制为"仅召回 + 仅 public scope/public 密级"。
      // 携带了令牌但令牌无效 → 仍然 401，绝不能把坏令牌当匿名放行。
      const hasCredentials =
        typeof request.headers.authorization === 'string' &&
        request.headers.authorization.trim().length > 0;
      if (
        !hasCredentials &&
        config.anonymousMode === 'public-readonly' &&
        isLoopbackRequest(request) &&
        error instanceof IdentityAuthenticationError &&
        error.code === 'authentication_required'
      ) {
        return {
          principalId: ANONYMOUS_PRINCIPAL_ID,
          credentialId: null,
          source: 'anonymous_loopback',
          authenticatedAt: new Date().toISOString(),
        };
      }
      throw error;
    }
  }
  if (!authorized(request)) {
    throw new IdentityAuthenticationError(
      'invalid_credentials',
      '需要有效的访问令牌',
    );
  }
  return Object.freeze({
    principalId: config.defaultUserId,
    credentialId: null,
    source: config.apiToken
      ? 'legacy_token' as const
      : 'anonymous_loopback' as const,
    authenticatedAt: new Date().toISOString(),
  });
}

function rejectClientIdentityOverride(
  value: unknown,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(record, 'userId') ||
    Object.prototype.hasOwnProperty.call(record, 'principalId')
  ) {
    throw new Error(
      'userId/principalId 由访问令牌确定，不能在请求体中指定',
    );
  }
}

function rejectClientRecallScopeOverride(value: unknown): void {
  rejectClientIdentityOverride(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const overridden = ['namespace', 'scopes', 'scopeType', 'scopeKey']
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (overridden.length > 0) {
    throw new Error(
      `${overridden.join('/')} 由可信连接或会话确定，` +
      '不能在 recall 请求体中指定',
    );
  }
}

function rejectIdentityQueryOverride(url: URL): void {
  if (
    url.searchParams.has('userId') ||
    url.searchParams.has('principalId')
  ) {
    throw new Error(
      'userId/principalId 由访问令牌确定，不能在查询参数中指定',
    );
  }
}

function identityManagementObject(
  value: unknown,
  allowedFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  rejectClientIdentityOverride(value);
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedFields);
  const unknownFields = Object.keys(record).filter(
    (field) => !allowed.has(field),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `${label}存在未知字段：${unknownFields.join(', ')}`,
    );
  }
  return record;
}

function identityManagementText(
  record: Record<string, unknown>,
  field: string,
  maximumLength = 255,
  optional = false,
): string | undefined {
  const value = record[field];
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${field} 无效`);
  }
  return value.trim();
}

function parseIdentityBootstrapInput(value: unknown): {
  displayName: string;
  label: string;
  expiresAt?: string;
} {
  const record = identityManagementObject(
    value,
    ['displayName', 'label', 'expiresAt'],
    '身份初始化参数',
  );
  return {
    displayName: identityManagementText(record, 'displayName')!,
    label: identityManagementText(record, 'label')!,
    expiresAt: identityManagementText(
      record,
      'expiresAt',
      255,
      true,
    ),
  };
}

function parseCredentialIssueInput(value: unknown): {
  label: string;
  expiresAt?: string;
} {
  const record = identityManagementObject(
    value,
    ['label', 'expiresAt'],
    '凭据签发参数',
  );
  return {
    label: identityManagementText(record, 'label')!,
    expiresAt: identityManagementText(
      record,
      'expiresAt',
      255,
      true,
    ),
  };
}

function parseCredentialRevocationInput(value: unknown): {
  reason?: string;
} {
  const record = identityManagementObject(
    value,
    ['reason'],
    '凭据撤销参数',
  );
  return {
    reason: identityManagementText(
      record,
      'reason',
      1000,
      true,
    ),
  };
}

function parseNumber(
  value: string | null,
  fallback: number,
): number {
  if (value === null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseReflectionScopeInput(
  value: unknown,
): {
  namespace: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  confirmed: boolean;
  implementationVersion?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('历史重提炼参数必须是 JSON 对象');
  }
  rejectClientIdentityOverride(value);
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'namespace',
    'scopeType',
    'scopeKey',
    'confirmed',
    'implementationVersion',
  ]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`未知历史重提炼字段：${unknown.join(', ')}`);
  }
  const scopeType = typeof record.scopeType === 'string'
    ? record.scopeType
    : 'personal';
  if (!['personal', 'project', 'role', 'session'].includes(scopeType)) {
    throw new Error('scopeType 必须是 personal/project/role/session');
  }
  const scopeKey = typeof record.scopeKey === 'string'
    ? record.scopeKey.normalize('NFKC').trim()
    : scopeType === 'personal'
      ? 'self'
      : '';
  if (!scopeKey) throw new Error('非 personal 历史重提炼必须指定 scopeKey');
  if (scopeType === 'personal' && scopeKey !== 'self') {
    throw new Error('personal 历史重提炼的 scopeKey 必须是 self');
  }
  const namespace = typeof record.namespace === 'string'
    ? record.namespace.normalize('NFKC').trim()
    : config.defaultNamespace;
  if (!namespace || namespace.length > 100) {
    throw new Error('namespace 长度必须为 1～100');
  }
  const implementationVersion =
    typeof record.implementationVersion === 'string'
      ? record.implementationVersion.normalize('NFKC').trim()
      : undefined;
  if (implementationVersion && implementationVersion.length > 200) {
    throw new Error('implementationVersion 不能超过 200 字符');
  }
  return {
    namespace,
    scopeType: scopeType as MemoryScopeType,
    scopeKey,
    confirmed: record.confirmed === true,
    ...(implementationVersion ? { implementationVersion } : {}),
  };
}

function parseRestoreInput(value: unknown): RestoreMemoryInput {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error('恢复参数必须是 JSON 对象');
  }
  const record = value as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (key) =>
      key !== 'confirmation' &&
      key !== 'confirmationToken',
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `存在未知恢复字段：${unknownFields.join(', ')}`,
    );
  }
  if (
    record.confirmation !== undefined &&
    record.confirmation !== 'replace'
  ) {
    throw new Error('恢复确认只允许 replace');
  }
  if (
    record.confirmationToken !== undefined &&
    (
      typeof record.confirmationToken !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(record.confirmationToken)
    )
  ) {
    throw new Error(
      'confirmationToken 必须是 64 位小写十六进制字符串',
    );
  }
  return {
    confirmation:
      record.confirmation === 'replace' ? 'replace' : undefined,
    confirmationToken:
      typeof record.confirmationToken === 'string'
        ? record.confirmationToken
        : undefined,
  };
}

function parseMemoryActionReviewInput(
  value: unknown,
): MemoryActionReviewInput {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error('记忆动作审核参数必须是 JSON 对象');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(['memoryId', 'content', 'value']);
  const unknownFields = Object.keys(record).filter(
    (key) => !allowed.has(key),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `存在未知记忆动作审核字段：${unknownFields.join(', ')}`,
    );
  }
  if (
    record.memoryId !== undefined &&
    (
      typeof record.memoryId !== 'string' ||
      !/^[0-9a-f-]{36}$/u.test(record.memoryId)
    )
  ) {
    throw new Error('memoryId 必须是小写 UUID');
  }
  if (
    record.content !== undefined &&
    (
      typeof record.content !== 'string' ||
      !record.content.trim() ||
      record.content.length > 2000
    )
  ) {
    throw new Error('content 必须是 1 到 2000 字符的字符串');
  }
  if (
    record.value !== undefined &&
    (
      typeof record.value !== 'string' ||
      !record.value.trim() ||
      record.value.length > 1000
    )
  ) {
    throw new Error('value 必须是 1 到 1000 字符的字符串');
  }
  return {
    memoryId:
      typeof record.memoryId === 'string'
        ? record.memoryId
        : undefined,
    content:
      typeof record.content === 'string'
        ? record.content.trim()
        : undefined,
    value:
      typeof record.value === 'string'
        ? record.value.trim()
        : undefined,
  };
}

function parseMemoryActionRejectInput(
  value: unknown,
): { blockFuture: boolean } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new Error('记忆动作拒绝参数必须是 JSON 对象');
  }
  const record = value as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (key) => key !== 'blockFuture',
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `存在未知记忆动作拒绝字段：${unknownFields.join(', ')}`,
    );
  }
  if (
    record.blockFuture !== undefined &&
    typeof record.blockFuture !== 'boolean'
  ) {
    throw new Error('blockFuture 必须是布尔值');
  }
  return { blockFuture: record.blockFuture === true };
}

function parseDeadLetterRecoveryInput(
  value: unknown,
): {
  jobId: string;
  mode: 'recompute' | 'repair' | 'supersede';
  reason?: string;
} {
  const record = identityManagementObject(
    value,
    ['jobId', 'mode', 'reason'],
    '死信恢复参数',
  );
  const mode = identityManagementText(record, 'mode', 32);
  if (!['recompute', 'repair', 'supersede'].includes(mode || '')) {
    throw new Error('死信恢复 mode 必须是 recompute、repair 或 supersede');
  }
  return {
    jobId: identityManagementText(record, 'jobId', 512)!,
    mode: mode as 'recompute' | 'repair' | 'supersede',
    reason: identityManagementText(
      record,
      'reason',
      1000,
      true,
    ) || undefined,
  };
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

async function ollamaStatus(
  options: HttpServerOptions,
): Promise<{
  available: boolean;
  models: string[];
}> {
  const fetchImpl = options.fetchImpl || fetch;
  try {
    const response = await fetchImpl(
      `${(options.ollamaBaseUrl || config.ollamaBaseUrl).replace(/\/+$/u, '')}/api/tags`,
      {
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) return { available: false, models: [] };
    const payload = await response.json() as {
      models?: Array<{ name?: unknown; model?: unknown }>;
    };
    const models = (payload.models || [])
      .map((entry) =>
        typeof entry.name === 'string'
          ? entry.name
          : typeof entry.model === 'string'
            ? entry.model
            : '',
      )
      .filter(Boolean);
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

function serveWeb(
  requestPath: string,
  response: ServerResponse,
): boolean {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = path.resolve(moduleDir, '../web');
  if (!fs.existsSync(webRoot)) return false;
  const requested =
    requestPath === '/'
      ? 'index.html'
      : decodeURIComponent(requestPath).replace(/^\/+/, '');
  let filePath = path.resolve(webRoot, requested);
  if (!filePath.startsWith(`${webRoot}${path.sep}`) && filePath !== webRoot) {
    sendError(response, 403, '禁止访问');
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(webRoot, 'index.html');
  }
  if (!fs.existsSync(filePath)) return false;
  const body = fs.readFileSync(filePath);
  response.writeHead(200, {
    'Content-Type': mimeType(filePath),
    'Content-Length': body.length,
    'Cache-Control': filePath.endsWith('.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
  response.end(body);
  return true;
}

export function createHttpServer(
  store: MemoryStore,
  options: HttpServerOptions = {},
): http.Server {
  const compatChatModel = parseCompatChatModel(
    options.compatChatModel ?? config.compatChatModel,
  );
  return http.createServer(async (request, response) => {
    const method = request.method || 'GET';
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || `${config.host}:${config.port}`}`,
    );

    try {
      if (method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'memory-bridge',
          version: '1.0.0',
          mcpTransport: 'stdio',
        });
        return;
      }

      const protectedRequest =
        url.pathname.startsWith(
          `${OLLAMA_COMPAT_PREFIX}/`,
        ) ||
        url.pathname.startsWith('/api/');
      const principal = protectedRequest
        ? authenticateRequest(request, options)
        : null;
      const principalId =
        principal?.principalId || config.defaultUserId;

      // 匿名公开通道端点白名单：@anonymous 仅允许召回（POST /api/recall）。
      // 写入、会话签发、管理端点一律 401——失败关闭，绝不放大。
      const isAnonymousPrincipal =
        principalId === ANONYMOUS_PRINCIPAL_ID;
      if (
        isAnonymousPrincipal &&
        !(method === 'POST' && url.pathname === '/api/recall')
      ) {
        sendError(
          response,
          401,
          '匿名访问仅允许召回公开资料（POST /api/recall）',
        );
        return;
      }

      if (
        options.conversationService &&
        principal &&
        await handleConversationHttp(request, response, url, {
          principalId,
          namespace: options.conversationNamespace ?? 'chat',
          principal,
          service: options.conversationService,
          chatEngine: options.conversationChatEngine,
        })
      ) {
        return;
      }

      if (
        config.compatProxy &&
        url.pathname.startsWith(`${OLLAMA_COMPAT_PREFIX}/`)
      ) {
        await handleOllamaCompatibilityProxy(
          request,
          response,
          url,
          {
            upstreamBaseUrl:
              options.ollamaBaseUrl ?? config.ollamaBaseUrl,
            chatModel: compatChatModel,
            timeoutMs:
              options.compatProxyTimeoutMs ??
              config.semanticTimeoutMs,
            fetchImpl: options.fetchImpl,
            lifecycle: options.memoryLifecycle,
            authenticatedPrincipal: principal
              ? {
                  principalId: principal.principalId,
                  namespace: config.defaultNamespace,
                  credentialId: principal.credentialId,
                  authSource: principal.source,
                  trustedPrincipal: principal,
                }
              : undefined,
          },
        );
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/identity/bootstrap'
      ) {
        if (!options.identityService || !principal) {
          sendError(response, 503, '身份服务未配置');
          return;
        }
        if (!isLoopbackRequest(request)) {
          sendError(response, 403, '首次身份初始化仅允许本机访问');
          return;
        }
        if (!trustedBootstrapBrowserRequest(request)) {
          sendError(response, 403, '首次身份初始化拒绝跨站浏览器请求');
          return;
        }
        if (!bootstrapUsesJson(request)) {
          sendError(
            response,
            415,
            '首次身份初始化要求 application/json',
          );
          return;
        }
        rejectIdentityQueryOverride(url);
        const input = parseIdentityBootstrapInput(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          201,
          options.identityService.initializeFirstAccount(input),
        );
        return;
      }

      if (method === 'GET' && url.pathname === '/api/identity') {
        if (!options.identityService || !principal) {
          sendError(response, 503, '身份服务未配置');
          return;
        }
        rejectIdentityQueryOverride(url);
        sendJson(
          response,
          200,
          options.identityService.currentOverview(principal),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/identity/credentials'
      ) {
        if (!options.identityService || !principal) {
          sendError(response, 503, '身份服务未配置');
          return;
        }
        rejectIdentityQueryOverride(url);
        sendJson(response, 200, {
          currentCredentialId: principal.credentialId,
          credentials: options.identityService.listCredentials(
            principal.principalId,
          ),
        });
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/identity/credentials'
      ) {
        if (!options.identityService || !principal) {
          sendError(response, 503, '身份服务未配置');
          return;
        }
        if (principal.source !== 'credential') {
          sendError(
            response,
            409,
            '请先通过本机首次身份初始化迁移到持久凭据',
          );
          return;
        }
        rejectIdentityQueryOverride(url);
        const input = parseCredentialIssueInput(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          201,
          options.identityService.issueCredential({
            principalId: principal.principalId,
            ...input,
          }),
        );
        return;
      }

      const credentialRevokeMatch = url.pathname.match(
        /^\/api\/identity\/credentials\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/revoke$/u,
      );
      if (method === 'POST' && credentialRevokeMatch) {
        if (!options.identityService || !principal) {
          sendError(response, 503, '身份服务未配置');
          return;
        }
        rejectIdentityQueryOverride(url);
        const input = parseCredentialRevocationInput(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          200,
          options.identityService.revokeCredentialForPrincipal(
            principal.principalId,
            credentialRevokeMatch[1],
            input.reason,
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/identity/personas'
      ) {
        if (!options.identityService || !principal) {
          sendError(response, 503, '身份服务未配置');
          return;
        }
        rejectIdentityQueryOverride(url);
        sendJson(response, 200, {
          personas: options.identityService.currentOverview(principal)
            .personas,
        });
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/chat-workspace/bootstrap'
      ) {
        if (!options.identityService || !options.conversationService || !principal) {
          sendError(response, 503, '本地聊天工作台未配置');
          return;
        }
        rejectIdentityQueryOverride(url);
        sendJson(response, 200, bootstrapLocalChatWorkspace(options, principal));
        return;
      }

      if (method === 'GET' && url.pathname === '/api/config') {
        sendJson(response, 200, {
          userId: principalId,
          defaultNamespace: config.defaultNamespace,
          tokenRequired: Boolean(config.apiToken),
          host: config.host,
          port: config.port,
          dataDir: config.dataDir,
          projectDir: process.cwd(),
          nodePath: process.execPath,
          semanticMode: config.semanticMode,
          ollamaBaseUrl: config.ollamaBaseUrl,
          queryModel: config.queryModel,
          modelKeepAlive: config.modelKeepAlive,
          foregroundQuietMs: config.foregroundQuietMs,
          embeddingModel: config.embeddingModel,
          rerankModel: config.rerankModel,
          extractionModel: config.extractionModel,
          relationModel: config.relationModel,
          explicitIntentModel: config.explicitIntentModel,
          consolidationModel: config.consolidationModel,
          reflectionModel: config.reflectionModel,
          automationMode: config.automationMode,
          extractorImplementation:
            MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
          qualityPipelineImplementation:
            NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
          compatChatModel,
          compatApiBaseUrl:
            `http://${config.host}:${config.port}` +
            `${OLLAMA_COMPAT_PREFIX}/v1`,
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/memories') {
        // 列侧同源：授权矩阵生效时，显式指定 scope 过滤必须在该
        // principal 的授权范围内（不指定 = 管理面全量，行为不变）。
        if (options.trustedSessions) {
          try {
            options.trustedSessions.assertScopeAllowed(
              principalId,
              url.searchParams.get('scopeType') || undefined,
              url.searchParams.get('scopeKey') || undefined,
            );
          } catch (error) {
            if (error instanceof TrustedSessionError) {
              sendError(response, error.statusCode, error.message);
              return;
            }
            throw error;
          }
        }
        const input: MemoryListInput = {
          userId: principalId,
          query: url.searchParams.get('query') || undefined,
          namespace: url.searchParams.get('namespace') || undefined,
          scopeType: (url.searchParams.get('scopeType') ||
            undefined) as MemoryListInput['scopeType'],
          scopeKey: url.searchParams.get('scopeKey') || undefined,
          kind: (url.searchParams.get('kind') ||
            undefined) as MemoryListInput['kind'],
          status: (url.searchParams.get('status') ||
            undefined) as MemoryListInput['status'],
          tag: url.searchParams.get('tag') || undefined,
          limit: parseNumber(url.searchParams.get('limit'), 100),
          offset: parseNumber(url.searchParams.get('offset'), 0),
        };
        sendJson(response, 200, store.list(input));
        return;
      }

      if (method === 'POST' && url.pathname === '/api/memories') {
        const input = await readJson<RememberInput>(request);
        rejectClientIdentityOverride(input);
        // 写读同源：授权矩阵生效时，写入受控 scope 必须在授权范围内；
        // 未指定 scope 落默认 personal/self，恒允许。矩阵不存在则零回归。
        if (options.trustedSessions) {
          try {
            options.trustedSessions.assertScopeAllowed(
              principalId,
              typeof input.scopeType === 'string'
                ? input.scopeType
                : undefined,
              typeof input.scopeKey === 'string'
                ? input.scopeKey
                : undefined,
            );
          } catch (error) {
            if (error instanceof TrustedSessionError) {
              sendError(response, error.statusCode, error.message);
              return;
            }
            throw error;
          }
        }
        sendJson(
          response,
          201,
          // 通道背书由服务端裁定：认证 API 直写即一手内容（origin=api），
          // 客户端声明的任何来源字段不参与信任判定。
          store.remember({ ...input, userId: principalId }, undefined, 'api'),
        );
        return;
      }

      const memoryMatch = url.pathname.match(
        /^\/api\/memories\/([0-9a-f-]+)$/,
      );
      if (memoryMatch && method === 'GET') {
        const memory = store.get(
          memoryMatch[1],
          true,
          principalId,
        );
        const detail = options.adminService
          ? options.adminService.memoryDetail(
              memoryMatch[1],
              principalId,
            )
          : null;
        if (!memory || (options.adminService && !detail)) {
          sendError(response, 404, '记忆不存在');
          return;
        }
        sendJson(
          response,
          200,
          detail || {
            memory,
            relations: store.relations(memory.id, principalId),
          },
        );
        return;
      }

      if (memoryMatch && method === 'PATCH') {
        const input = await readJson<UpdateMemoryInput>(request);
        rejectClientIdentityOverride(input);
        sendJson(
          response,
          200,
          store.update(memoryMatch[1], input, principalId),
        );
        return;
      }

      if (memoryMatch && method === 'DELETE') {
        const body = await readJson<{ reason?: string }>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          store.forget(
            memoryMatch[1],
            body.reason,
            principalId,
          ),
        );
        return;
      }

      const restoreMatch = url.pathname.match(
        /^\/api\/memories\/([0-9a-f-]+)\/restore$/,
      );
      if (restoreMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const body = parseRestoreInput(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          200,
          await options.adminService.restoreMemory(
            restoreMatch[1],
            body,
            principalId,
          ),
        );
        return;
      }

      const revertMatch = url.pathname.match(
        /^\/api\/memories\/([0-9a-f-]+)\/revert$/,
      );
      if (revertMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const body = await readJson<{ versionId?: string }>(request);
        rejectClientIdentityOverride(body);
        if (!body.versionId) {
          sendError(response, 400, 'versionId 不能为空');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.revertMemory(
            revertMatch[1],
            body.versionId,
            principalId,
          ),
        );
        return;
      }

      const pinMatch = url.pathname.match(
        /^\/api\/memories\/([0-9a-f-]+)\/pin$/,
      );
      if (pinMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const body = await readJson<{ pinned?: boolean }>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          options.adminService.pinMemory(
            pinMatch[1],
            body.pinned !== false,
            principalId,
          ),
        );
        return;
      }

      const archiveMatch = url.pathname.match(
        /^\/api\/memories\/([0-9a-f-]+)\/archive$/,
      );
      if (archiveMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const body = await readJson<{ reason?: unknown }>(request);
        rejectClientIdentityOverride(body);
        if (
          body.reason !== undefined &&
          (
            typeof body.reason !== 'string' ||
            !body.reason.trim() ||
            body.reason.length > 500
          )
        ) {
          sendError(response, 400, 'reason 必须是 1 到 500 字符的字符串');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.archiveMemory(
            archiveMatch[1],
            typeof body.reason === 'string'
              ? body.reason.trim()
              : undefined,
            principalId,
          ),
        );
        return;
      }

      const unarchiveMatch = url.pathname.match(
        /^\/api\/memories\/([0-9a-f-]+)\/unarchive$/,
      );
      if (unarchiveMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        rejectClientIdentityOverride(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          200,
          options.adminService.unarchiveMemory(
            unarchiveMatch[1],
            principalId,
          ),
        );
        return;
      }

      const ttlMatch = url.pathname.match(
        /^\/api\/memories\/([0-9a-f-]+)\/ttl$/,
      );
      if (ttlMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const body = await readJson<{
          expiresAt?: string | null;
        }>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          options.adminService.setMemoryTtl(
            ttlMatch[1],
            body.expiresAt ?? null,
            principalId,
          ),
        );
        return;
      }

      const purgeMatch = url.pathname.match(
        /^\/api\/memories\/([0-9a-f-]+)\/purge$/,
      );
      if (purgeMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const body = await readJson<{ reason?: string }>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          202,
          options.adminService.memoryGovernance.queuePurge(
            purgeMatch[1],
            body.reason,
            principalId,
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/reflection/status'
      ) {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        rejectIdentityQueryOverride(url);
        sendJson(
          response,
          200,
          options.reflectionService.status(
            principalId,
            url.searchParams.get('namespace') || config.defaultNamespace,
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/reflection/runs'
      ) {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        rejectIdentityQueryOverride(url);
        sendJson(
          response,
          200,
          options.reflectionService.listRuns(
            principalId,
            parseNumber(url.searchParams.get('limit'), 100),
          ),
        );
        return;
      }

      if (
        method === 'PUT' &&
        url.pathname === '/api/reflection/settings'
      ) {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        const body = await readJson<{
          namespace?: unknown;
          mode?: unknown;
          userId?: unknown;
          principalId?: unknown;
        }>(request);
        rejectClientIdentityOverride(body);
        if (body.mode !== 'off' && body.mode !== 'shadow') {
          throw new Error('历史重提炼 mode 必须是 off 或 shadow');
        }
        const namespace = typeof body.namespace === 'string'
          ? body.namespace.normalize('NFKC').trim()
          : config.defaultNamespace;
        sendJson(
          response,
          200,
          options.reflectionService.setMode(
            principalId,
            namespace,
            body.mode,
          ),
        );
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/reflection/preview'
      ) {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        const input = parseReflectionScopeInput(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          200,
          await options.reflectionService.preview({
            userId: principalId,
            namespace: input.namespace,
            scopeType: input.scopeType,
            scopeKey: input.scopeKey,
          }),
        );
        return;
      }

      if (
        method === 'POST' &&
        (
          url.pathname === '/api/reflection/reextract' ||
          url.pathname === '/api/reflection/run'
        )
      ) {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        const input = parseReflectionScopeInput(
          await readJson<unknown>(request),
        );
        if (!input.confirmed) {
          sendError(
            response,
            409,
            '请先预览预计 turn 和模型调用量，再以 confirmed=true 确认运行',
            'REFLECTION_CONFIRMATION_REQUIRED',
          );
          return;
        }
        const queued = options.reflectionService.queueRun({
          userId: principalId,
          namespace: input.namespace,
          scopeType: input.scopeType,
          scopeKey: input.scopeKey,
          runType: url.pathname.endsWith('/reextract')
            ? 'reextract'
            : 'reflect',
          trigger: 'manual',
          requestedBy: principalId,
          implementationVersion: input.implementationVersion,
        });
        sendJson(response, 202, queued);
        return;
      }

      const reflectionRunMatch = url.pathname.match(
        /^\/api\/reflection\/runs\/([0-9a-f-]+)$/u,
      );
      if (reflectionRunMatch && method === 'GET') {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        const run = options.reflectionService.getRun(
          reflectionRunMatch[1],
          principalId,
        );
        if (!run) {
          sendError(
            response,
            404,
            '历史重提炼运行不存在',
            'REFLECTION_RUN_NOT_FOUND',
          );
          return;
        }
        sendJson(response, 200, {
          run,
          events: options.reflectionService.runEvents(
            run.id,
            principalId,
          ),
          modelCalls: options.reflectionService.modelCalls(
            run.id,
            principalId,
          ),
        });
        return;
      }

      const reflectionRetryMatch = url.pathname.match(
        /^\/api\/reflection\/runs\/([0-9a-f-]+)\/retry$/u,
      );
      if (reflectionRetryMatch && method === 'POST') {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        sendJson(
          response,
          202,
          options.reflectionService.retryRun(
            reflectionRetryMatch[1],
            principalId,
          ),
        );
        return;
      }

      const reflectionCancelMatch = url.pathname.match(
        /^\/api\/reflection\/runs\/([0-9a-f-]+)\/cancel$/u,
      );
      if (reflectionCancelMatch && method === 'POST') {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.reflectionService.cancelRun(
            reflectionCancelMatch[1],
            principalId,
          ),
        );
        return;
      }

      const reflectionEvidenceMatch = url.pathname.match(
        /^\/api\/reflection\/candidates\/([0-9a-f-]+)\/evidence$/u,
      );
      if (reflectionEvidenceMatch && method === 'GET') {
        if (!options.reflectionService) {
          sendError(response, 503, '历史重提炼服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.reflectionService.candidateEvidence(
            reflectionEvidenceMatch[1],
            principalId,
          ),
        );
        return;
      }

      const reflectionConfirmMatch = url.pathname.match(
        /^\/api\/reflection\/candidates\/([0-9a-f-]+)\/confirm$/u,
      );
      if (reflectionConfirmMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '候选审核服务未配置');
          return;
        }
        const body = await readJson<{ content?: string; value?: string }>(
          request,
        );
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          options.adminService.acceptCandidate(
            reflectionConfirmMatch[1],
            body,
            principalId,
          ),
        );
        return;
      }

      const reflectionRejectMatch = url.pathname.match(
        /^\/api\/reflection\/candidates\/([0-9a-f-]+)\/reject$/u,
      );
      if (reflectionRejectMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '候选审核服务未配置');
          return;
        }
        const body = await readJson<{ blockFuture?: boolean }>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          options.adminService.rejectCandidate(
            reflectionRejectMatch[1],
            body.blockFuture === true,
            principalId,
          ),
        );
        return;
      }

      if (method === 'GET' && url.pathname === '/api/candidates') {
        if (!options.adminService) {
          sendError(response, 503, '候选审核服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.listCandidateInbox(
            parseNumber(url.searchParams.get('limit'), 200),
            principalId,
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/action-requests'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '记忆动作审核服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.listMemoryActionInbox(
            parseNumber(url.searchParams.get('limit'), 200),
            principalId,
          ),
        );
        return;
      }

      const actionAcceptMatch = url.pathname.match(
        /^\/api\/action-requests\/([0-9a-f-]+)\/accept$/,
      );
      if (actionAcceptMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '记忆动作审核服务未配置');
          return;
        }
        const body = parseMemoryActionReviewInput(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          200,
          options.adminService.acceptMemoryActionRequest(
            actionAcceptMatch[1],
            body,
            principalId,
          ),
        );
        return;
      }

      const actionRejectMatch = url.pathname.match(
        /^\/api\/action-requests\/([0-9a-f-]+)\/reject$/,
      );
      if (actionRejectMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '记忆动作审核服务未配置');
          return;
        }
        const body = parseMemoryActionRejectInput(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          200,
          options.adminService.rejectMemoryActionRequest(
            actionRejectMatch[1],
            body.blockFuture,
            principalId,
          ),
        );
        return;
      }

      const candidateAcceptMatch = url.pathname.match(
        /^\/api\/candidates\/([0-9a-f-]+)\/accept$/,
      );
      if (candidateAcceptMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '候选审核服务未配置');
          return;
        }
        const body = await readJson<{
          content?: string;
          value?: string;
        }>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          options.adminService.acceptCandidate(
            candidateAcceptMatch[1],
            body,
            principalId,
          ),
        );
        return;
      }

      const candidateRejectMatch = url.pathname.match(
        /^\/api\/candidates\/([0-9a-f-]+)\/reject$/,
      );
      if (candidateRejectMatch && method === 'POST') {
        if (!options.adminService) {
          sendError(response, 503, '候选审核服务未配置');
          return;
        }
        const body = await readJson<{
          blockFuture?: boolean;
        }>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          options.adminService.rejectCandidate(
            candidateRejectMatch[1],
            body.blockFuture === true,
            principalId,
          ),
        );
        return;
      }

      // ── 可信会话签发（服务对服务路径的部门级隔离）──────────
      // 授权矩阵未配置时整体 503（失败关闭）；签发逐项校验矩阵，
      // 全部通过才创建；scope 签发后冻结。
      if (method === 'POST' && url.pathname === '/api/sessions') {
        if (!options.trustedSessions) {
          sendError(response, 503, '可信会话签发服务未配置');
          return;
        }
        const body = await readJson<{
          scopes?: Array<{ scopeType?: unknown; scopeKey?: unknown }>;
          ttlSeconds?: number;
          clearance?: unknown;
        }>(request);
        rejectClientIdentityOverride(body);
        if (
          body.clearance !== undefined &&
          body.clearance !== 'public' &&
          body.clearance !== 'internal' &&
          body.clearance !== 'confidential'
        ) {
          sendError(
            response,
            400,
            'clearance 必须是 public/internal/confidential',
          );
          return;
        }
        const clearance = (body.clearance ?? 'internal') as
          | 'public'
          | 'internal'
          | 'confidential';
        const scopes = (body.scopes ?? []).map((scope) => {
          if (
            !scope ||
            typeof scope !== 'object' ||
            typeof scope.scopeType !== 'string' ||
            typeof scope.scopeKey !== 'string'
          ) {
            throw new TrustedSessionError(
              400,
              'scopes 每项必须是 { scopeType, scopeKey }',
            );
          }
          return {
            scopeType: scope.scopeType as TrustedSessionScope['scopeType'],
            scopeKey: scope.scopeKey,
          };
        });
        try {
          const record = options.trustedSessions.issue(
            principalId,
            scopes,
            body.ttlSeconds,
            clearance,
          );
          sendJson(response, 201, record);
        } catch (error) {
          if (error instanceof TrustedSessionError) {
            sendError(response, error.statusCode, error.message);
            return;
          }
          throw error;
        }
        return;
      }

      const trustedSessionMatch = url.pathname.match(
        /^\/api\/sessions\/([0-9a-f-]{36})$/,
      );
      if (trustedSessionMatch && options.trustedSessions) {
        const sessionId = trustedSessionMatch[1];
        if (method === 'GET') {
          const record = options.trustedSessions.get(sessionId);
          if (!record || record.principalId !== principalId) {
            sendError(response, 404, '会话不存在');
            return;
          }
          sendJson(response, 200, record);
          return;
        }
        if (method === 'DELETE') {
          const revoked = options.trustedSessions.revoke(
            sessionId,
            principalId,
          );
          if (!revoked) {
            sendError(response, 404, '会话不存在');
            return;
          }
          sendJson(response, 200, { ok: true, revoked: true });
          return;
        }
      }

      // 答案工具：列出全部注册工具（含参数说明），供调用方
      // 动态发现并暴露给生成模型。
      if (method === 'GET' && url.pathname === '/api/tools') {
        sendJson(response, 200, {
          tools: answerToolRegistry.list(),
        });
        return;
      }

      // 答案工具：调用。POST /api/tools/<name>/invoke，body 为参数对象。
      // 工具为纯确定性计算（无副作用、不触库），鉴权与其他 /api 一致。
      const toolInvokeMatch = url.pathname.match(
        /^\/api\/tools\/([a-z][a-z0-9_]{1,31})\/invoke$/,
      );
      if (toolInvokeMatch && method === 'POST') {
        const body = await readJson<Record<string, unknown>>(
          request,
        ).catch(() => ({}) as Record<string, unknown>);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendError(response, 400, '请求体必须是 JSON 对象（工具参数）');
          return;
        }
        const result = await answerToolRegistry.invoke(
          toolInvokeMatch[1],
          body,
        );
        sendJson(response, result.ok ? 200 : 400, result);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/recall') {
        const input = await readJson<RecallInput>(request);
        rejectClientRecallScopeOverride(input);
        const {
          recentTurns,
          namespace: _ignoredNamespace,
          scopes: _ignoredScopes,
          scopeType: _ignoredScopeType,
          scopeKey: _ignoredScopeKey,
          ...recallInput
        } = input;
        const boundNamespace = config.defaultNamespace;
        const sessionExternalId = requestHeader(
          request,
          'x-memory-session-id',
        );
        // 匿名公开通道：只看 public scope + public 密级，且无个人记忆。
        let boundClearance: 'public' | 'internal' | 'confidential' =
          isAnonymousPrincipal ? 'public' : 'internal';
        let boundScopes: RecallInput['scopes'] = isAnonymousPrincipal
          ? [{ scopeType: 'public', scopeKey: 'public' }]
          : [{ scopeType: 'personal', scopeKey: 'self' }];
        if (sessionExternalId) {
          // ① API 签发的可信会话（服务对服务路径）：命中即用，
          //    非活跃（过期/吊销/主体不符）显式 401，绝不回落放大。
          let apiIssued: TrustedSessionRecord | null = null;
          if (options.trustedSessions) {
            try {
              apiIssued = options.trustedSessions
                .resolveForRecall(sessionExternalId, principalId);
            } catch (error) {
              if (error instanceof TrustedSessionError) {
                sendError(response, error.statusCode, error.message);
                return;
              }
              throw error;
            }
          }
          if (apiIssued) {
            boundScopes = [
              { scopeType: 'personal', scopeKey: 'self' },
              ...apiIssued.scopes.map((scope) => ({
                scopeType: scope.scopeType,
                scopeKey: scope.scopeKey,
              })),
            ];
            // 密级跟随会话（签发时已按主体授权收窄）。
            boundClearance = apiIssued.clearance;          } else {
            // ② conversation 体系派生的聊天会话（原路径，零回归）。
            const clientName = requestHeader(request, 'x-memory-client-name');
            if (!clientName) {
              throw new Error(
                '绑定会话召回时必须提供 x-memory-client-name',
              );
            }
            if (!options.adminService) {
              throw new MemoryAdminUnavailableError(
                '可信会话作用域绑定服务未配置',
              );
            }
            const resolved = options.adminService.lifecycle
              .boundConversationScopes({
                userId: principalId,
                namespace: boundNamespace,
                clientName,
                sessionExternalId,
              });
            if (!resolved) throw new Error('可信会话不存在');
            boundScopes = resolved;
          }
        }
        const understandingInput = {
          principalId,
          sessionId: sessionExternalId || undefined,
          roundId: requestHeader(request, 'x-memory-round-id') ||
            requestHeader(request, 'x-request-id') ||
            undefined,
          originalQuery: recallInput.query,
          recentTurns: untrustedQueryContextTurns(recentTurns),
          currentTime: new Date().toISOString(),
        };
        const queryUnderstanding = options.queryUnderstandingService
          ? await options.queryUnderstandingService.understand(
            understandingInput,
          )
          : undefined;
        sendJson(
          response,
          200,
          await store.getContextReliable({
            ...recallInput,
            userId: principalId,
            namespace: boundNamespace,
            scopes: boundScopes,
            clearance: boundClearance,
            scopeType: undefined,
            scopeKey: undefined,
          }, {
            queryUnderstanding,
            qualityFallback: options.queryUnderstandingService
              ? () => options.queryUnderstandingService!.understand(
                understandingInput,
                { forceQualityFallback: true },
              )
              : undefined,
          }),
        );
        return;
      }

      if (method === 'GET' && url.pathname === '/api/audit') {
        sendJson(
          response,
          200,
          store.audits(
            parseNumber(url.searchParams.get('limit'), 100),
            parseNumber(url.searchParams.get('offset'), 0),
            principalId,
          ),
        );
        return;
      }

      if (method === 'GET' && url.pathname === '/api/stats') {
        sendJson(response, 200, store.stats(principalId));
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/dead-letters/recover'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '死信恢复服务未配置');
          return;
        }
        const input = parseDeadLetterRecoveryInput(
          await readJson<unknown>(request),
        );
        sendJson(
          response,
          202,
          options.adminService.recoverDeadLetterJob(
            input.jobId,
            principalId,
            config.defaultNamespace,
            input.mode,
            input.reason,
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/system-health'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '系统健康服务未配置');
          return;
        }
        const status = await ollamaStatus(options);
        sendJson(
          response,
          200,
          options.adminService.systemHealth({
            ollamaAvailable: status.available,
            availableModels: status.models,
            chatModel: compatChatModel,
          }, principalId),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/consolidations'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '巩固服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.listConsolidations(
            parseNumber(url.searchParams.get('limit'), 200),
            principalId,
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/tombstones'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.listTombstones(
            parseNumber(url.searchParams.get('limit'), 200),
            principalId,
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/purge-jobs'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.memoryGovernance.listPurgeJobs(
            principalId,
            parseNumber(url.searchParams.get('limit'), 100),
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/retention-policies'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.memoryGovernance.listPolicies(
            principalId,
          ),
        );
        return;
      }

      if (
        method === 'PUT' &&
        url.pathname === '/api/retention-policies'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const body = await readJson<Parameters<
          MemoryAdminService['memoryGovernance']['upsertPolicy']
        >[0]>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          options.adminService.memoryGovernance.upsertPolicy({
            ...body,
            userId: principalId,
          }),
        );
        return;
      }

      if (method === 'GET' && url.pathname === '/api/recalls') {
        if (!options.adminService) {
          sendError(response, 503, '召回解释服务未配置');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.listRecallExplanations(
            parseNumber(url.searchParams.get('limit'), 100),
            principalId,
          ),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/retrieval-traces'
      ) {
        const quality = url.searchParams.get('qualityState');
        const qualityState =
          quality === 'full' ||
          quality === 'degraded' ||
          quality === 'unavailable'
            ? quality
            : undefined;
        sendJson(
          response,
          200,
          store.listRetrievalTraces({
            namespace: url.searchParams.get('namespace') || undefined,
            qualityState,
            resultId: url.searchParams.get('resultId') || undefined,
            since: url.searchParams.get('since') || undefined,
            until: url.searchParams.get('until') || undefined,
            limit: parseNumber(url.searchParams.get('limit'), 100),
            offset: parseNumber(url.searchParams.get('offset'), 0),
          }, principalId),
        );
        return;
      }

      const traceExportMatch = url.pathname.match(
        /^\/api\/retrieval-traces\/([0-9a-f-]+)\/export$/u,
      );
      if (method === 'GET' && traceExportMatch) {
        const trace = store.getRetrievalTrace(
          traceExportMatch[1],
          principalId,
        );
        if (!trace) {
          sendError(response, 404, '检索 trace 不存在');
          return;
        }
        sendJson(response, 200, trace, {
          'Content-Disposition':
            `attachment; filename="retrieval-trace-${trace.traceId}.json"`,
        });
        return;
      }

      const traceDetailMatch = url.pathname.match(
        /^\/api\/retrieval-traces\/([0-9a-f-]+)$/u,
      );
      if (method === 'GET' && traceDetailMatch) {
        const trace = store.getRetrievalTrace(
          traceDetailMatch[1],
          principalId,
        );
        if (!trace) {
          sendError(response, 404, '检索 trace 不存在');
          return;
        }
        sendJson(response, 200, trace);
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/retrieval-traces/prune'
      ) {
        const body = await readJson<{ before?: string }>(request);
        rejectClientIdentityOverride(body);
        sendJson(response, 200, {
          deleted: store.pruneRetrievalTraces(
            body.before,
            principalId,
          ),
        });
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/retrieval-log/health'
      ) {
        sendJson(
          response,
          200,
          store.retrievalLogHealth(principalId),
        );
        return;
      }

      if (
        method === 'GET' &&
        url.pathname === '/api/feedback-examples'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const requestedFeedback = url.searchParams.get('feedback');
        const feedback =
          requestedFeedback === 'used' ||
          requestedFeedback === 'confirmed' ||
          requestedFeedback === 'rejected'
            ? requestedFeedback
            : undefined;
        sendJson(
          response,
          200,
          options.adminService.memoryGovernance.listFeedbackExamples(
            principalId,
            {
              feedback,
              limit: parseNumber(url.searchParams.get('limit'), 200),
              offset: parseNumber(url.searchParams.get('offset'), 0),
            },
          ),
        );
        return;
      }

      if (
        method === 'POST' &&
        url.pathname === '/api/memory-doctor'
      ) {
        if (!options.adminService) {
          sendError(response, 503, '记忆健康服务未配置');
          return;
        }
        const body = await readJson<{
          sampleLimit?: number;
          oversizedCharacterThreshold?: number;
          zeroResultHotspotThreshold?: number;
        }>(request);
        rejectClientIdentityOverride(body);
        sendJson(
          response,
          200,
          options.adminService.runMemoryDoctor(principalId, body),
        );
        return;
      }

      if (method === 'POST' && url.pathname === '/api/feedback') {
        if (!options.adminService) {
          sendError(response, 503, '治理服务未配置');
          return;
        }
        const body = await readJson<{
          memoryId?: string;
          feedback?: 'retrieved' | 'used' | 'confirmed' | 'rejected';
          traceId?: string;
        }>(request);
        rejectClientIdentityOverride(body);
        if (!body.memoryId || !body.feedback) {
          sendError(response, 400, 'memoryId 和 feedback 不能为空');
          return;
        }
        sendJson(
          response,
          200,
          options.adminService.memoryGovernance.recordFeedback(
            body.memoryId,
            body.feedback,
            principalId,
            body.traceId,
          ),
        );
        return;
      }

      if (method === 'GET' && url.pathname === '/api/export') {
        const payload = store.exportAll(principalId);
        sendJson(response, 200, payload, {
          'Content-Disposition':
            'attachment; filename="memory-bridge-backup.json"',
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/import') {
        const payload = await readJson<Parameters<
          MemoryStore['importAll']
        >[0]>(request);
        sendJson(
          response,
          200,
          store.importAll(payload, principalId),
        );
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendError(response, 404, '接口不存在');
        return;
      }

      if (method === 'GET' && serveWeb(url.pathname, response)) {
        return;
      }
      sendError(response, 404, '页面不存在');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '服务器内部错误';
      if (error instanceof MemoryReflectionError) {
        sendError(response, error.status, message, error.code);
        return;
      }
      const status =
        error instanceof IdentityAuthenticationError
          ? 401
          : error instanceof IdentityBootstrapConflictError
            ? 409
          : error instanceof MemoryAdminUnavailableError
          ? 503
          : message === '记忆不存在' ||
              message === '候选记忆不存在' ||
              message === '记忆动作请求不存在' ||
              message === '目标历史版本不存在' ||
              message === '记忆不存在或不属于当前用户' ||
              message === 'dead letter 不存在或不属于当前账户' ||
              message === '可信会话不存在' ||
              message === '身份凭据不存在'
            ? 404
            : /已过期|已变化|删除世代|正在被其他审核处理|已经处理|已经被拒绝|不能拒绝/u.test(
                message,
              )
              ? 409
              : 400;
      sendError(
        response,
        status,
        message,
      );
    }
  });
}
