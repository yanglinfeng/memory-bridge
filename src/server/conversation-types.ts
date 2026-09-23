/**
 * 会话服务的公开类型与错误定义。
 *
 * 从 conversation-service.ts 原样搬出（零逻辑改写）。
 * conversation-service.ts 通过 export * 转发本模块，消费方 import 路径不变。
 */
import type { AssistantActionType } from './assistant-protocol.js';

export interface ConversationTenant {
  readonly principalId: string;
  readonly namespace: string;
}

export type ConversationServiceErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_CURSOR'
  | 'SYNC_CURSOR_EXPIRED'
  | 'PERSONA_NOT_FOUND'
  | 'PERSONA_PROFILE_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'CONVERSATION_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'CONVERSATION_ARCHIVED'
  | 'ROUND_NOT_FOUND'
  | 'ROUND_IN_PROGRESS'
  | 'REGENERATION_NOT_LATEST'
  | 'DELETE_POLICY_CONFLICT'
  | 'INVALID_EVENT_CURSOR'
  | 'EVENT_HISTORY_EXPIRED'
  | 'VL_SERVICE_DISABLED'
  | 'ASSISTANT_PROTOCOL_INVALID'
  | 'MODEL_UNAVAILABLE'
  | 'MEMORY_RECALL_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE';

export class ConversationServiceError extends Error {
  override readonly name = 'ConversationServiceError';

  constructor(readonly code: ConversationServiceErrorCode) {
    super(`conversation service error: ${code}`);
  }
}

export interface ChatProfileInput {
  readonly expectedVersion: number;
  readonly displayName: string;
  readonly systemPrompt: string;
  readonly greeting: string;
  readonly language: string;
  readonly capabilityIds: readonly string[];
}

export interface ChatProfileVersionSummary {
  readonly profileVersion: number;
  readonly updatedAt: string;
}

export interface ChatProfile {
  readonly personaId: string;
  readonly profileVersion: number;
  readonly displayName: string;
  readonly systemPrompt: string;
  readonly greeting: string;
  readonly language: string;
  readonly capabilityIds: readonly string[];
  readonly updatedAt: string;
  readonly availableVersions: readonly ChatProfileVersionSummary[];
}

export interface ProjectBinding {
  readonly projectId: string;
  readonly displayName: string;
  readonly status: 'active' | 'archived';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Conversation {
  readonly id: string;
  readonly personaId: string;
  readonly projectId: string | null;
  readonly personaProfileVersion: number;
  readonly title: string | null;
  readonly status: 'active' | 'archived';
  readonly messageCount: number;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface MessageAction {
  readonly id: string;
  readonly type: AssistantActionType;
  readonly payload: Readonly<{ name: string }>;
}

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly role: 'user' | 'assistant';
  readonly displayContent: string;
  readonly actions: readonly MessageAction[];
  readonly attachments: readonly never[];
  readonly status: 'completed';
  readonly generationGroupId: string | null;
  readonly variantIndex: number;
  readonly isActiveVariant: boolean;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly version: number;
}

export type ConversationRoundStatus =
  | 'accepted'
  | 'understanding'
  | 'recalling'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'deleted';

export type ConversationRoundStage =
  | 'accepted'
  | 'understanding'
  | 'recalling'
  | 'generating'
  | 'completed';

export type ConversationRoundEventType =
  | 'turn.accepted'
  | 'turn.stage'
  | 'assistant.delta'
  | 'assistant.action'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.interrupted'
  | 'turn.deleted';

export interface ConversationRoundAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly type: 'initial' | 'retry' | 'regenerate';
  readonly status:
    | 'accepted'
    | 'running'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'deleted';
  readonly requestId: string;
  readonly generation: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface ConversationRound {
  readonly id: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly status: ConversationRoundStatus;
  readonly personaProfileVersionUsed: number;
  readonly generation: number;
  readonly userMessage: ConversationMessage;
  readonly assistantMessage: ConversationMessage | null;
  readonly currentAttempt: ConversationRoundAttempt | null;
  readonly failure: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
    stage: string;
  }> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface ConversationRoundEvent {
  readonly id: string;
  readonly sequence: number;
  readonly type: ConversationRoundEventType;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface AcceptedConversationRound {
  readonly round: ConversationRound;
  readonly shouldExecute: boolean;
  readonly replayed: boolean;
}

export interface ConversationRoundExecutionContext {
  readonly roundId: string;
  readonly attemptId: string;
  readonly requestId: string;
  readonly generation: number;
  readonly tenant: ConversationTenant;
  readonly conversation: Conversation;
  readonly personaId: string;
  readonly projectId: string | null;
  readonly profile: ChatProfile;
  readonly messages: readonly Readonly<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>[];
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface ConversationPage extends CursorPage<Conversation> {
  readonly syncCursor: string;
}

export interface MessagePage extends CursorPage<ConversationMessage> {
  readonly conversationVersion: number;
}

export type ConversationChangeType =
  | 'conversation.upsert'
  | 'conversation.delete'
  | 'message.upsert'
  | 'message.delete'
  | 'message.active_variant';

export interface ConversationChange {
  readonly sequence: number;
  readonly type: ConversationChangeType;
  readonly conversationId: string;
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly occurredAt: string;
  readonly tombstone: boolean;
  readonly resource: Readonly<Record<string, unknown>> | null;
}

export interface ConversationChangePage
extends CursorPage<ConversationChange> {
  readonly serverTime: string;
}

export type ConversationMemoryPolicy =
  | 'retain_derived_memories'
  | 'forget_derived_memories';

export interface ConversationDeletionReceipt {
  readonly id: string;
  readonly resourceType: 'message' | 'conversation';
  readonly resourceId: string;
  readonly conversationId: string;
  readonly memoryPolicy: ConversationMemoryPolicy;
  readonly affectedMessageIds: readonly string[];
  readonly memoryActionRequestIds: readonly string[];
  readonly cancelledRoundIds: readonly string[];
  readonly purgeJobId: string;
  readonly status: 'accepted';
  readonly createdAt: string;
}

export interface ConversationDoctorReport {
  readonly checkedAt: string;
  readonly healthy: boolean;
  readonly checks: Readonly<{
    stuckRounds: number;
    regenerationMismatches: number;
    orphanMessages: number;
    orphanActions: number;
    orphanEvidence: number;
    protocolContamination: number;
    extractionZeroCandidateWithoutReason: number;
    pendingMaintenanceJobs: number;
    deadMaintenanceJobs: number;
    importConflicts: number;
    unmatchedImportSessions: number;
    changeLag: number;
  }>;
}

export interface ConversationAuditInput {
  readonly action: 'started' | 'completed' | 'failed';
  readonly conversationId: string;
  readonly roundId: string;
  readonly requestId: string;
  readonly attemptId?: string;
  readonly code?: string;
  readonly model?: string;
  readonly durationMs?: number;
  readonly recallDurationMs?: number;
  readonly providerDurationMs?: number;
  readonly firstTokenMs?: number;
}

export interface ConversationImportInput {
  readonly dryRun: boolean;
  readonly importId: string;
  readonly batchCursor: string | null;
  readonly isLastBatch: boolean;
  readonly conversations: readonly Readonly<{
    externalSessionId: string;
    personaId: string;
    projectId: string | null;
    title: string | null;
    messages: readonly Readonly<{
      externalMessageId: string;
      externalRoundId: string;
      role: 'user' | 'assistant';
      displayContent: string;
      occurredAt: string;
    }>[];
  }>[];
}

export interface ConversationImportStats {
  readonly created: number;
  readonly matched: number;
  readonly conflicted: number;
  readonly skipped: number;
  readonly conversations: Readonly<{
    created: number;
    matched: number;
    conflicted: number;
    skipped: number;
  }>;
  readonly messages: Readonly<{
    created: number;
    matched: number;
    conflicted: number;
    skipped: number;
  }>;
}

export interface ConversationImportReceipt {
  readonly importId: string;
  readonly lane: 'dry_run' | 'commit';
  readonly batchIndex: number;
  readonly batchCursor: string;
  readonly isLastBatch: boolean;
  readonly replayed: boolean;
  readonly stats: ConversationImportStats;
}

export interface ConversationServiceOptions {
  readonly now?: () => Date | string;
  readonly cursorTtlMs?: number;
  readonly roundLeaseMs?: number;
  readonly roundEventRetentionMs?: number;
  readonly instanceId?: string;
}
