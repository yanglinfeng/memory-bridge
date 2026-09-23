import type { AuthenticatedPrincipal } from './identity.js';
import type { ChatLifecycle } from './ollama-compat.js';
import {
  AssistantProtocolQuarantineError,
  StreamingAssistantProtocolSanitizer,
} from './assistant-protocol.js';
import {
  ConversationService,
  ConversationServiceError,
  type ConversationRoundExecutionContext,
  type ConversationTenant,
} from './conversation-service.js';

const MAX_PROVIDER_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_RECONCILE_MS = 30_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface ConversationChatProviderInput {
  readonly model: string;
  readonly messages: readonly Readonly<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>[];
  readonly requestId: string;
}

export interface ConversationChatProvider {
  generate(
    input: ConversationChatProviderInput,
    signal: AbortSignal,
    onDelta?: (rawDelta: string) => void | Promise<void>,
  ): Promise<string>;
}

export class ConversationChatProviderError extends Error {
  override readonly name = 'ConversationChatProviderError';

  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`conversation chat provider error: ${code}`);
  }
}

export interface OllamaConversationChatProviderOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class OllamaConversationChatProvider
implements ConversationChatProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: OllamaConversationChatProviderOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('conversation chat provider timeoutMs 无效');
    }
  }

  async generate(
    input: ConversationChatProviderInput,
    signal: AbortSignal,
    onDelta?: (rawDelta: string) => void | Promise<void>,
  ): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.chatUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson, application/json',
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          stream: true,
        }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new ConversationChatProviderError(
          'PROVIDER_REQUEST_CANCELLED',
          true,
        );
      }
      if (timeoutSignal.aborted) {
        throw new ConversationChatProviderError(
          'PROVIDER_TIMEOUT',
          true,
        );
      }
      throw new ConversationChatProviderError(
        'PROVIDER_UNAVAILABLE',
        true,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConversationChatProviderError(
        `PROVIDER_HTTP_${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    if (!response.body) {
      throw new ConversationChatProviderError(
        'PROVIDER_EMPTY_RESPONSE',
        true,
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (/application\/json/iu.test(contentType) &&
        !/ndjson/iu.test(contentType)) {
      const content = this.contentFromPayload(
        await this.readJsonResponse(response, combinedSignal),
      );
      if (!content) {
        throw new ConversationChatProviderError(
          'PROVIDER_EMPTY_RESPONSE',
          true,
        );
      }
      await onDelta?.(content);
      return content;
    }
    return await this.readNdjsonResponse(
      response,
      combinedSignal,
      onDelta,
    );
  }

  private chatUrl(): URL {
    const base = new URL(this.options.baseUrl);
    base.pathname = `${base.pathname.replace(/\/$/u, '')}/api/chat`;
    base.search = '';
    base.hash = '';
    return base;
  }

  private async readJsonResponse(
    response: Response,
    signal: AbortSignal,
  ): Promise<unknown> {
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new ConversationChatProviderError(
          'PROVIDER_REQUEST_CANCELLED',
          true,
        );
      }
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ConversationChatProviderError(
          'PROVIDER_RESPONSE_TOO_LARGE',
          false,
        );
      }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      .toString('utf8');
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ConversationChatProviderError(
        'PROVIDER_INVALID_RESPONSE',
        true,
      );
    }
  }

  private async readNdjsonResponse(
    response: Response,
    signal: AbortSignal,
    onDelta?: (rawDelta: string) => void | Promise<void>,
  ): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let content = '';
    let size = 0;
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new ConversationChatProviderError(
          'PROVIDER_REQUEST_CANCELLED',
          true,
        );
      }
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ConversationChatProviderError(
          'PROVIDER_RESPONSE_TOO_LARGE',
          false,
        );
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const delta = this.contentFromPayload(this.parsePayload(line));
        if (delta) await onDelta?.(delta);
        content += delta;
      }
    }
    pending += decoder.decode();
    if (pending.trim()) {
      const delta = this.contentFromPayload(this.parsePayload(pending));
      if (delta) await onDelta?.(delta);
      content += delta;
    }
    if (!content) {
      throw new ConversationChatProviderError(
        'PROVIDER_EMPTY_RESPONSE',
        true,
      );
    }
    return content;
  }

  private parsePayload(value: string): unknown {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new ConversationChatProviderError(
        'PROVIDER_INVALID_RESPONSE',
        true,
      );
    }
  }

  private contentFromPayload(value: unknown): string {
    if (!isRecord(value)) {
      throw new ConversationChatProviderError(
        'PROVIDER_INVALID_RESPONSE',
        true,
      );
    }
    if (typeof value.error === 'string' && value.error) {
      throw new ConversationChatProviderError(
        'PROVIDER_REPORTED_ERROR',
        true,
      );
    }
    if (!isRecord(value.message)) return '';
    if (
      Array.isArray(value.message.tool_calls) &&
      value.message.tool_calls.length > 0
    ) {
      throw new ConversationChatProviderError(
        'PROVIDER_TOOL_CALL_FORBIDDEN',
        false,
      );
    }
    return typeof value.message.content === 'string'
      ? value.message.content
      : '';
  }
}

export interface ConversationChatIdentity {
  readonly credentialId: string | null;
  readonly authSource: string;
  readonly trustedPrincipal?: AuthenticatedPrincipal;
}

export interface ConversationChatAuditEvent {
  readonly action: 'started' | 'completed' | 'failed';
  readonly conversationId: string;
  readonly roundId: string;
  readonly requestId: string;
  readonly model: string;
  readonly attemptId?: string;
  readonly code?: string;
  readonly durationMs?: number;
  readonly recallDurationMs?: number;
  readonly providerDurationMs?: number;
  readonly firstTokenMs?: number;
}

export interface ConversationChatEngineOptions {
  readonly model: string;
  readonly provider: ConversationChatProvider;
  readonly lifecycle?: ChatLifecycle;
  readonly heartbeatMs?: number;
  readonly reconcileMs?: number;
  readonly audit?: (event: ConversationChatAuditEvent) => void;
}

export class ConversationChatEngine {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly heartbeatMs: number;
  private readonly reconcileTimer: NodeJS.Timeout;

  constructor(
    private readonly service: ConversationService,
    private readonly options: ConversationChatEngineOptions,
  ) {
    if (!options.model.trim()) throw new Error('conversation chat model 不能为空');
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS;
    if (
      !Number.isSafeInteger(this.heartbeatMs) ||
      this.heartbeatMs <= 0 ||
      !Number.isSafeInteger(reconcileMs) ||
      reconcileMs <= 0
    ) {
      throw new Error('conversation chat timer 配置无效');
    }
    this.reconcileTimer = setInterval(
      () => this.service.reconcileExpiredRounds(),
      reconcileMs,
    );
    this.reconcileTimer.unref();
  }

  start(
    tenant: ConversationTenant,
    conversationId: string,
    roundId: string,
    identity: ConversationChatIdentity,
  ): Promise<void> {
    const existing = this.active.get(roundId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(roundId, controller);
    const execution = this.execute(
      tenant,
      conversationId,
      roundId,
      identity,
      controller.signal,
    ).finally(() => {
      this.active.delete(roundId);
      this.controllers.delete(roundId);
    });
    this.active.set(roundId, execution);
    return execution;
  }

  cancel(roundId: string): void {
    this.controllers.get(roundId)?.abort();
  }

  close(): void {
    clearInterval(this.reconcileTimer);
    for (const controller of this.controllers.values()) controller.abort();
  }

  private async execute(
    tenant: ConversationTenant,
    conversationId: string,
    roundId: string,
    identity: ConversationChatIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    let context: ConversationRoundExecutionContext | null = null;
    let stage = 'accepted';
    let lifecycleRequest: Record<string, unknown> | null = null;
    let requestId = roundId;
    let recallDurationMs: number | undefined;
    let providerDurationMs: number | undefined;
    let firstTokenMs: number | undefined;
    try {
      context = this.service.beginRoundExecution(
        tenant,
        conversationId,
        roundId,
      );
      requestId = context.requestId;
      this.audit(tenant, conversationId, {
        action: 'started',
        roundId,
        requestId,
        attemptId: context.attemptId,
      });
      const heartbeat = setInterval(
        () => this.service.heartbeatRound(tenant, conversationId, roundId),
        this.heartbeatMs,
      );
      heartbeat.unref();
      try {
        stage = 'recalling';
        if (!this.service.advanceRoundStage(
          tenant,
          conversationId,
          roundId,
          'recalling',
        )) {
          return;
        }
        const request: Record<string, unknown> = {
          model: this.options.model,
          messages: context.messages,
          stream: true,
        };
        const recallStartedAt = Date.now();
        try {
          lifecycleRequest = this.options.lifecycle
            ? await this.options.lifecycle.beforeModel(
              request,
              context.requestId,
              {
                principalId: tenant.principalId,
                namespace: tenant.namespace,
                credentialId: identity.credentialId,
                authSource: identity.authSource,
                trustedPrincipal: identity.trustedPrincipal,
                clientName: 'conversation-api',
                personaId: context.personaId,
                sessionId: conversationId,
                roundId,
                projectId: context.projectId,
                identityStatus: 'complete',
              },
            )
            : request;
        } finally {
          recallDurationMs = Date.now() - recallStartedAt;
        }
        stage = 'generating';
        if (!this.service.advanceRoundStage(
          tenant,
          conversationId,
          roundId,
          'generating',
        )) {
          return;
        }
        const messages = this.providerMessages(lifecycleRequest);
        const streamingSanitizer =
          new StreamingAssistantProtocolSanitizer();
        const providerStartedAt = Date.now();
        let assistantContent: string;
        try {
          assistantContent = await this.options.provider.generate(
            {
              model: this.options.model,
              messages,
              requestId: context.requestId,
            },
            signal,
            (rawDelta) => {
              firstTokenMs ??= Date.now() - providerStartedAt;
              const displayDelta = streamingSanitizer.push(rawDelta);
              if (displayDelta) {
                this.service.appendRoundDelta(
                  tenant,
                  conversationId,
                  roundId,
                  displayDelta,
                );
              }
            },
          );
        } finally {
          providerDurationMs = Date.now() - providerStartedAt;
        }
        const completed = this.service.completeRound(
          tenant,
          conversationId,
          roundId,
          assistantContent,
        );
        if (completed) {
          this.audit(tenant, conversationId, {
            action: 'completed',
            roundId,
            requestId: context.requestId,
            attemptId: context.attemptId,
            durationMs: Date.now() - startedAt,
            recallDurationMs,
            providerDurationMs,
            firstTokenMs,
          });
        }
      } finally {
        clearInterval(heartbeat);
        await this.options.lifecycle?.cancelTurn?.(requestId);
      }
    } catch (error) {
      const failure = this.classifyFailure(error, stage);
      try {
        this.service.failRound(tenant, conversationId, roundId, failure);
      } catch {
        // 删除屏障或其他终态已经胜出时，不允许晚到失败覆盖权威状态。
      }
      this.audit(tenant, conversationId, {
        action: 'failed',
        roundId,
        requestId,
        attemptId: context?.attemptId,
        code: failure.code,
        durationMs: Date.now() - startedAt,
        recallDurationMs,
        providerDurationMs,
        firstTokenMs,
      });
      if (lifecycleRequest) {
        await this.options.lifecycle?.cancelTurn?.(requestId);
      }
    }
  }

  private providerMessages(
    request: Record<string, unknown>,
  ): ConversationChatProviderInput['messages'] {
    if (!Array.isArray(request.messages)) {
      throw new ConversationChatProviderError(
        'PROVIDER_REQUEST_INVALID',
        false,
      );
    }
    return Object.freeze(request.messages.map((message) => {
      if (
        !isRecord(message) ||
        !['system', 'user', 'assistant'].includes(String(message.role)) ||
        typeof message.content !== 'string'
      ) {
        throw new ConversationChatProviderError(
          'PROVIDER_REQUEST_INVALID',
          false,
        );
      }
      return Object.freeze({
        role: String(message.role) as 'system' | 'user' | 'assistant',
        content: message.content,
      });
    }));
  }

  private classifyFailure(
    error: unknown,
    stage: string,
  ): {
    code: string;
    message: string;
    retryable: boolean;
    stage: string;
    interrupted?: boolean;
  } {
    if (error instanceof AssistantProtocolQuarantineError) {
      return {
        code: 'ASSISTANT_PROTOCOL_INVALID',
        message: '助手输出协议无效，已拒绝写入历史',
        retryable: true,
        stage,
      };
    }
    if (error instanceof ConversationChatProviderError) {
      if (error.code === 'PROVIDER_TOOL_CALL_FORBIDDEN') {
        return {
          code: 'ASSISTANT_PROTOCOL_INVALID',
          message: '助手输出包含未授权工具调用，已拒绝写入历史',
          retryable: true,
          stage,
        };
      }
      return {
        code: 'MODEL_UNAVAILABLE',
        message: '模型服务未能完成本轮回复',
        retryable: error.retryable,
        stage,
        interrupted: error.code === 'PROVIDER_REQUEST_CANCELLED',
      };
    }
    if (error instanceof ConversationServiceError) {
      return {
        code: error.code,
        message: '会话服务未能完成本轮回复',
        retryable: error.code === 'SERVICE_UNAVAILABLE',
        stage,
      };
    }
    if (stage === 'recalling') {
      return {
        code: 'MEMORY_RECALL_UNAVAILABLE',
        message: '长期记忆召回未能完成本轮请求',
        retryable: true,
        stage,
      };
    }
    return {
      code: 'ROUND_EXECUTION_FAILED',
      message: '本轮执行失败',
      retryable: true,
      stage,
    };
  }

  private audit(
    tenant: ConversationTenant,
    conversationId: string,
    event: Omit<ConversationChatAuditEvent, 'conversationId' | 'model'>,
  ): void {
    const enriched = Object.freeze({
      ...event,
      conversationId,
      model: this.options.model,
    });
    try {
      this.service.recordConversationAudit(tenant, enriched);
    } catch {
      // 审计故障不能改变会话真相，也不得回退打印请求或回复正文。
    }
    try {
      if (this.options.audit) this.options.audit(enriched);
      else console.info(`[conversation-chat] ${JSON.stringify(enriched)}`);
    } catch {
      // 外部审计 sink 故障同样不能改变权威会话状态。
    }
  }
}
