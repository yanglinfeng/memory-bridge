import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationChatEngine } from './conversation-chat.js';
import {
  ConversationService,
  ConversationServiceError,
  type ConversationServiceErrorCode,
} from './conversation-service.js';
import type { AuthenticatedPrincipal } from './identity.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

class ConversationHttpError extends Error {
  override readonly name = 'ConversationHttpError';

  constructor(readonly code: 'FORBIDDEN_IDENTITY_OVERRIDE') {
    super(`conversation http error: ${code}`);
  }
}

const ERROR_STATUS: Readonly<Record<ConversationServiceErrorCode, number>> = {
  INVALID_REQUEST: 400,
  INVALID_CURSOR: 400,
  SYNC_CURSOR_EXPIRED: 410,
  PERSONA_NOT_FOUND: 404,
  PERSONA_PROFILE_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  CONVERSATION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  CONVERSATION_ARCHIVED: 409,
  ROUND_NOT_FOUND: 404,
  ROUND_IN_PROGRESS: 409,
  REGENERATION_NOT_LATEST: 409,
  DELETE_POLICY_CONFLICT: 409,
  INVALID_EVENT_CURSOR: 400,
  EVENT_HISTORY_EXPIRED: 410,
  VL_SERVICE_DISABLED: 501,
  ASSISTANT_PROTOCOL_INVALID: 502,
  MODEL_UNAVAILABLE: 503,
  MEMORY_RECALL_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
};

const ERROR_MESSAGE: Readonly<Record<ConversationServiceErrorCode, string>> = {
  INVALID_REQUEST: '请求参数无效',
  INVALID_CURSOR: '分页游标无效或已过期',
  SYNC_CURSOR_EXPIRED: '增量同步游标已过期，请重新全量同步',
  PERSONA_NOT_FOUND: '角色不存在或无权访问',
  PERSONA_PROFILE_NOT_FOUND: '角色聊天档案不存在',
  PROJECT_NOT_FOUND: '项目不存在或无权访问',
  CONVERSATION_NOT_FOUND: '会话不存在或无权访问',
  MESSAGE_NOT_FOUND: '消息不存在或无权访问',
  IDEMPOTENCY_CONFLICT: '幂等键已用于不同请求',
  VERSION_CONFLICT: '资源版本已变化',
  CONVERSATION_ARCHIVED: '会话已归档',
  ROUND_NOT_FOUND: '对话轮次不存在或无权访问',
  ROUND_IN_PROGRESS: '当前会话已有正在执行的轮次',
  REGENERATION_NOT_LATEST: '只能重新生成当前会话最新一轮回复',
  DELETE_POLICY_CONFLICT: '资源已按另一种记忆策略删除',
  INVALID_EVENT_CURSOR: '事件恢复位置无效',
  EVENT_HISTORY_EXPIRED: '事件恢复历史已过期',
  VL_SERVICE_DISABLED: 'VL 服务暂未开启',
  ASSISTANT_PROTOCOL_INVALID: '助手输出协议无效',
  MODEL_UNAVAILABLE: '模型服务暂时不可用',
  MEMORY_RECALL_UNAVAILABLE: '长期记忆召回暂时不可用',
  SERVICE_UNAVAILABLE: '会话生成服务未配置',
};

const RETRYABLE_ERRORS = new Set<ConversationServiceErrorCode>([
  'ROUND_IN_PROGRESS',
  'ASSISTANT_PROTOCOL_INVALID',
  'MODEL_UNAVAILABLE',
  'MEMORY_RECALL_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
]);

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendServiceError(
  response: ServerResponse,
  error: ConversationServiceError,
): void {
  sendJson(response, ERROR_STATUS[error.code], {
    error: ERROR_MESSAGE[error.code],
    code: error.code,
    retryable: RETRYABLE_ERRORS.has(error.code),
    requestId: randomUUID(),
  });
}

function sendHttpError(
  response: ServerResponse,
  error: ConversationHttpError,
): void {
  sendJson(response, 400, {
    error: '身份只能由访问令牌和服务端 namespace 确定',
    code: error.code,
    retryable: false,
    requestId: randomUUID(),
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ConversationServiceError('INVALID_REQUEST');
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ConversationServiceError('INVALID_REQUEST');
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationServiceError('INVALID_REQUEST');
  }
  return value as Record<string, unknown>;
}

function rejectIdentityOverride(value: Record<string, unknown>): void {
  for (const field of ['userId', 'principalId', 'namespace']) {
    if (Object.hasOwn(value, field)) {
      throw new ConversationHttpError('FORBIDDEN_IDENTITY_OVERRIDE');
    }
  }
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowlist = new Set(allowed);
  if (Object.keys(value).some((field) => !allowlist.has(field))) {
    throw new ConversationServiceError('INVALID_REQUEST');
  }
}

function integerQuery(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new ConversationServiceError('INVALID_REQUEST');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConversationServiceError('INVALID_REQUEST');
  }
  return parsed;
}

function pathId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ConversationServiceError('INVALID_REQUEST');
  }
}

function requestHeader(
  request: IncomingMessage,
  name: string,
): string | null {
  const value = request.headers[name];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value[0]?.trim()) return value[0].trim();
  return null;
}

function acceptsEventStream(request: IncomingMessage): boolean {
  const accept = requestHeader(request, 'accept');
  return accept !== null && accept
    .split(',')
    .some((value) => /^text\/event-stream(?:\s*;|$)/iu.test(value.trim()));
}

async function writeSse(
  response: ServerResponse,
  event: {
    readonly id: string;
    readonly type: string;
    readonly data: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const payload =
    `id: ${event.id}\n` +
    `event: ${event.type}\n` +
    `data: ${JSON.stringify(event.data)}\n\n`;
  if (response.write(payload)) return;
  await new Promise<void>((resolve) => response.once('drain', resolve));
}

async function streamRoundEvents(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly service: ConversationService;
    readonly tenant: { readonly principalId: string; readonly namespace: string };
    readonly conversationId: string;
    readonly roundId: string;
    readonly afterEventId: string | null;
  },
): Promise<void> {
  let afterEventId = input.afterEventId;
  let pending = input.service.listRoundEvents(
    input.tenant,
    input.conversationId,
    input.roundId,
    { afterEventId, limit: 256 },
  );
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
  let closed = false;
  let lastHeartbeatAt = Date.now();
  response.once('close', () => {
    closed = true;
  });
  while (!closed) {
    for (const event of pending) {
      await writeSse(response, event);
      afterEventId = event.id;
      if (closed) return;
    }
    if (pending.length === 256) {
      pending = input.service.listRoundEvents(
        input.tenant,
        input.conversationId,
        input.roundId,
        { afterEventId, limit: 256 },
      );
      continue;
    }
    const round = input.service.getRound(
      input.tenant,
      input.conversationId,
      input.roundId,
    );
    pending = input.service.listRoundEvents(
      input.tenant,
      input.conversationId,
      input.roundId,
      { afterEventId, limit: 256 },
    );
    if (pending.length > 0) continue;
    if (input.service.isRoundTerminal(round.status)) {
      response.end();
      return;
    }
    if (Date.now() - lastHeartbeatAt >= 15_000) {
      response.write(': keep-alive\n\n');
      lastHeartbeatAt = Date.now();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    pending = input.service.listRoundEvents(
      input.tenant,
      input.conversationId,
      input.roundId,
      { afterEventId, limit: 256 },
    );
  }
}

export interface ConversationHttpContext {
  readonly principalId: string;
  readonly namespace: string;
  readonly principal: AuthenticatedPrincipal;
  readonly service: ConversationService;
  readonly chatEngine?: ConversationChatEngine;
}

export async function handleConversationHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ConversationHttpContext,
): Promise<boolean> {
  const method = request.method || 'GET';
  const tenant = {
    principalId: context.principalId,
    namespace: context.namespace,
  };

  try {
    if (url.searchParams.has('userId') ||
        url.searchParams.has('principalId') ||
        url.searchParams.has('namespace')) {
      throw new ConversationHttpError('FORBIDDEN_IDENTITY_OVERRIDE');
    }

    const profileMatch = url.pathname.match(
      /^\/api\/personas\/([^/]+)\/chat-profile$/u,
    );
    if (profileMatch && method === 'PUT') {
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, [
        'expectedVersion',
        'displayName',
        'systemPrompt',
        'greeting',
        'language',
        'capabilityIds',
      ]);
      sendJson(response, 200, context.service.putChatProfile(
        tenant,
        pathId(profileMatch[1]),
        body as unknown as Parameters<ConversationService['putChatProfile']>[2],
      ));
      return true;
    }
    if (profileMatch && method === 'GET') {
      sendJson(response, 200, context.service.getChatProfile(
        tenant,
        pathId(profileMatch[1]),
        integerQuery(url.searchParams.get('version')),
      ));
      return true;
    }

    const projectMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/binding$/u,
    );
    if (projectMatch && method === 'PUT') {
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, ['expectedVersion', 'displayName']);
      sendJson(response, 200, context.service.putProjectBinding(
        tenant,
        pathId(projectMatch[1]),
        body as unknown as Parameters<ConversationService['putProjectBinding']>[2],
      ));
      return true;
    }
    if (url.pathname === '/api/projects' && method === 'GET') {
      sendJson(response, 200, { items: context.service.listProjects(tenant) });
      return true;
    }

    if (url.pathname === '/api/conversations/changes' && method === 'GET') {
      sendJson(response, 200, context.service.listChanges(tenant, {
        cursor: url.searchParams.get('cursor'),
        limit: integerQuery(url.searchParams.get('limit')),
      }));
      return true;
    }

    if (url.pathname === '/api/conversations/doctor' && method === 'GET') {
      sendJson(
        response,
        200,
        context.service.runConversationDoctor(tenant),
      );
      return true;
    }

    if (url.pathname === '/api/conversations/import' && method === 'POST') {
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, [
        'dryRun',
        'importId',
        'batchCursor',
        'isLastBatch',
        'conversations',
      ]);
      sendJson(
        response,
        200,
        context.service.importConversations(
          tenant,
          body as unknown as Parameters<
            ConversationService['importConversations']
          >[1],
        ),
      );
      return true;
    }

    const deleteMessageMatch = url.pathname.match(
      /^\/api\/messages\/([^/]+)$/u,
    );
    if (deleteMessageMatch && method === 'DELETE') {
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, [
        'clientRequestId',
        'reason',
        'memoryPolicy',
      ]);
      const receipt = context.service.deleteMessage(
        tenant,
        pathId(deleteMessageMatch[1]),
        body as unknown as Parameters<ConversationService['deleteMessage']>[2],
      );
      for (const roundId of receipt.cancelledRoundIds) {
        context.chatEngine?.cancel(roundId);
      }
      sendJson(response, 202, receipt);
      return true;
    }

    if (url.pathname === '/api/conversations' && method === 'POST') {
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, [
        'idempotencyKey',
        'personaId',
        'projectId',
        'title',
      ]);
      sendJson(response, 201, context.service.createConversation(
        tenant,
        body as unknown as Parameters<ConversationService['createConversation']>[1],
      ));
      return true;
    }
    if (url.pathname === '/api/conversations' && method === 'GET') {
      const projectValue = url.searchParams.get('projectId');
      const projectProvided = url.searchParams.has('projectId');
      sendJson(response, 200, context.service.listConversations(tenant, {
        personaId: url.searchParams.get('personaId') ?? undefined,
        ...(projectProvided
          ? { projectId: projectValue === '' || projectValue === 'null'
              ? null
              : projectValue }
          : {}),
        status: (url.searchParams.get('status') ?? undefined) as
          'active' | 'archived' | undefined,
        cursor: url.searchParams.get('cursor'),
        limit: integerQuery(url.searchParams.get('limit')),
      }));
      return true;
    }

    const regenerateMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/regenerate$/u,
    );
    if (regenerateMatch && method === 'POST') {
      if (!context.chatEngine) {
        throw new ConversationServiceError('SERVICE_UNAVAILABLE');
      }
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, [
        'clientRequestId',
        'sourceAssistantMessageId',
      ]);
      const conversationId = pathId(regenerateMatch[1]);
      const accepted = context.service.regenerate(
        tenant,
        conversationId,
        body as unknown as Parameters<ConversationService['regenerate']>[2],
      );
      if (accepted.shouldExecute) {
        void context.chatEngine.start(
          tenant,
          conversationId,
          accepted.round.id,
          {
            credentialId: context.principal.credentialId,
            authSource: context.principal.source,
            trustedPrincipal: context.principal,
          },
        );
      }
      sendJson(response, 202, accepted);
      return true;
    }

    const messagesMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/messages$/u,
    );
    if (messagesMatch && method === 'POST') {
      if (!context.chatEngine) {
        throw new ConversationServiceError('SERVICE_UNAVAILABLE');
      }
      if (!acceptsEventStream(request)) {
        throw new ConversationServiceError('INVALID_REQUEST');
      }
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, [
        'clientMessageId',
        'text',
        'attachments',
        'clientSentAt',
      ]);
      const conversationId = pathId(messagesMatch[1]);
      const accepted = context.service.acceptRound(
        tenant,
        conversationId,
        body as unknown as Parameters<ConversationService['acceptRound']>[2],
      );
      if (accepted.shouldExecute) {
        void context.chatEngine.start(
          tenant,
          conversationId,
          accepted.round.id,
          {
            credentialId: context.principal.credentialId,
            authSource: context.principal.source,
            trustedPrincipal: context.principal,
          },
        );
      }
      await streamRoundEvents(request, response, {
        service: context.service,
        tenant,
        conversationId,
        roundId: accepted.round.id,
        afterEventId: requestHeader(request, 'last-event-id'),
      });
      return true;
    }
    if (messagesMatch && method === 'GET') {
      sendJson(response, 200, context.service.listMessages(
        tenant,
        pathId(messagesMatch[1]),
        {
          before: url.searchParams.get('before'),
          afterSequence: integerQuery(url.searchParams.get('afterSequence')),
          limit: integerQuery(url.searchParams.get('limit')),
        },
      ));
      return true;
    }

    const roundEventsMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/rounds\/([^/]+)\/events$/u,
    );
    if (roundEventsMatch && method === 'GET') {
      if (!acceptsEventStream(request)) {
        throw new ConversationServiceError('INVALID_REQUEST');
      }
      await streamRoundEvents(request, response, {
        service: context.service,
        tenant,
        conversationId: pathId(roundEventsMatch[1]),
        roundId: pathId(roundEventsMatch[2]),
        afterEventId: requestHeader(request, 'last-event-id'),
      });
      return true;
    }

    const roundMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/rounds\/([^/]+)$/u,
    );
    if (roundMatch && method === 'GET') {
      sendJson(response, 200, context.service.getRound(
        tenant,
        pathId(roundMatch[1]),
        pathId(roundMatch[2]),
      ));
      return true;
    }

    const conversationMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)$/u,
    );
    if (conversationMatch && method === 'GET') {
      sendJson(response, 200, context.service.getConversation(
        tenant,
        pathId(conversationMatch[1]),
      ));
      return true;
    }
    if (conversationMatch && method === 'PATCH') {
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, [
        'expectedVersion',
        'title',
        'status',
        'personaProfileVersion',
      ]);
      sendJson(response, 200, context.service.updateConversation(
        tenant,
        pathId(conversationMatch[1]),
        body as unknown as Parameters<ConversationService['updateConversation']>[2],
      ));
      return true;
    }
    if (conversationMatch && method === 'DELETE') {
      const body = object(await readJson(request));
      rejectIdentityOverride(body);
      rejectUnknownFields(body, [
        'clientRequestId',
        'reason',
        'memoryPolicy',
      ]);
      const receipt = context.service.deleteConversation(
        tenant,
        pathId(conversationMatch[1]),
        body as unknown as Parameters<
          ConversationService['deleteConversation']
        >[2],
      );
      for (const roundId of receipt.cancelledRoundIds) {
        context.chatEngine?.cancel(roundId);
      }
      sendJson(response, 202, receipt);
      return true;
    }

    return false;
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return true;
    }
    if (error instanceof ConversationHttpError) {
      sendHttpError(response, error);
      return true;
    }
    if (error instanceof ConversationServiceError) {
      sendServiceError(response, error);
      return true;
    }
    throw error;
  }
}
