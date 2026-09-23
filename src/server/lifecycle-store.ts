import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isClientIdentityId } from './client-identity-contract.js';
import {
  config,
  SYSTEM_JOB_NAMESPACE,
  SYSTEM_JOB_USER_ID,
} from './config.js';
import {
  alignSourceExcerpt,
  containsCredentialSecret,
  namedRoleScopeNamesFromText,
  normalizeAtomicCandidateContent,
  protectedCredentialSensitivity,
  structuredAtomicCandidateText,
} from './memory-extractor.js';
import {
  MEMORY_KINDS,
  type MemoryAccessScope,
  type MemoryKind,
  type MemoryScopeType,
  type MemorySensitivity,
  type SourceAuthority,
} from './types.js';

type DatabaseRow = Record<string, unknown>;

const EXPLICIT_PROJECT_SCOPE_PATTERN =
  /(?:项目专属|(?:只|仅)(?:能)?(?:属于|用于|限于|在)(?:当前|这个|该|本)?项目(?:里|中)?(?:使用|生效|可见)?)/u;
const EXPLICIT_ROLE_SCOPE_PATTERN =
  /(?:当前角色(?:独有|专属|私有)|角色专属|(?:只|仅)(?:能)?(?:属于|用于|限于|在)(?:当前|这个|该|本)?角色(?:里|中)?(?:使用|生效|可见|沿用)?|其他角色(?:不应|不能|不要|不用|无需|不必)(?:看到|可见|使用|沿用|继承|共享)|不(?:向|给)其他角色(?:共享|公开|沿用))/u;
const EXPLICIT_PERSONAL_SCOPE_PATTERN =
  /(?:(?:所有|每个|任何)角色(?:中|里)?(?:都|均)?(?:一样|适用|共享|通用|沿用)|(?:这个|该|此)?(?:偏好|事实|信息|设定|记忆)?(?:在)?(?:所有|每个|任何)角色(?:中|里)?(?:都|均)?(?:一样|适用|共享|通用|沿用)|(?:不分|无论|不论|跨)角色(?:(?:都|均)?(?:共享|通用|适用|一样|沿用)|(?:之间|间)(?:共享|通用))|角色(?:之间|间)(?:共享|通用))/u;

export type TurnRole = 'system' | 'user' | 'assistant' | 'tool';
export type ConversationIdentityStatus =
  | 'complete'
  | 'degraded'
  | 'legacy';

export interface BoundConversationScopeInput {
  userId: string;
  namespace: string;
  clientName: string;
  sessionExternalId: string;
}

export class ConversationIdentityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationIdentityConflictError';
  }
}
export type CandidateState =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'conflicted';
export type Sensitivity = MemorySensitivity;
export type CandidateRelation =
  | 'equivalent'
  | 'reinforces'
  | 'supersedes'
  | 'contradicts'
  | 'coexists';
export type CandidateResolutionMethod =
  | 'exact'
  | 'rule'
  | 'embedding'
  | 'model'
  | 'manual';

export interface CandidateResolutionAudit {
  relation: CandidateRelation;
  targetMemoryItemId?: string | null;
  method: CandidateResolutionMethod;
  confidence: number;
  model?: string;
  promptVersion?: string;
  rationale: string;
  status?: 'completed' | 'failed';
  error?: string;
}

export interface RecordTurnInput {
  userId?: string;
  namespace?: string;
  personaId?: string | null;
  projectId?: string | null;
  identitySource?: string;
  identityStatus?: ConversationIdentityStatus;
  roundId?: string | null;
  clientName: string;
  sessionExternalId: string;
  turnExternalId: string;
  role: TurnRole;
  content: string;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export interface EnsureConversationSessionInput {
  userId?: string;
  namespace?: string;
  personaId?: string | null;
  projectId?: string | null;
  identitySource?: string;
  identityStatus?: ConversationIdentityStatus;
  roundId?: string | null;
  clientName: string;
  sessionExternalId: string;
  startedAt?: string;
}

export interface ConversationTurn {
  id: string;
  sessionId: string;
  userId: string;
  namespace: string;
  externalId: string;
  role: TurnRole;
  content: string;
  occurredAt: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface RecordTurnResult {
  turn: ConversationTurn;
  created: boolean;
  sessionId: string;
}

export interface ConversationLineageKey {
  fingerprint: string;
  keyType: 'exact' | 'suffix';
  messageCount: number;
}

export interface TurnToolEventInput {
  callId: string;
  toolName: string;
  argumentsHash?: string;
  resultHash?: string;
  resultStatus: 'requested' | 'completed' | 'failed';
}

export interface RecordCompletedExchangeInput {
  userId?: string;
  namespace?: string;
  personaId?: string | null;
  projectId?: string | null;
  identitySource?: string;
  identityStatus?: ConversationIdentityStatus;
  roundId?: string | null;
  clientName: string;
  sessionExternalId: string;
  userTurnExternalId: string;
  userContent: string;
  assistantTurnExternalId: string;
  assistantContent: string;
  occurredAt?: string;
  userMetadata?: Record<string, unknown>;
  assistantMetadata?: Record<string, unknown>;
  lineageKeys?: ConversationLineageKey[];
  toolEvents?: TurnToolEventInput[];
}

export interface RecordCompletedExchangeResult {
  sessionId: string;
  userTurn: ConversationTurn;
  assistantTurn: ConversationTurn;
  created: boolean;
}

export interface MemoryJob {
  id: string;
  jobType: string;
  userId: string;
  namespace: string;
  payload: Record<string, unknown>;
  requiredModelId: string | null;
  requiredGenerationId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dead';
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseUntil: string | null;
  leaseOwner: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type JobFailureClass =
  | 'transient'
  | 'protocol'
  | 'coverage'
  | 'source_drift'
  | 'unsupported'
  | 'unknown';

export type DeadLetterRecoveryMode =
  | 'recompute'
  | 'repair'
  | 'supersede';

export interface JobFailureOptions {
  retryable?: boolean;
  failureClass?: JobFailureClass;
  inputFingerprint?: string;
  outputFingerprint?: string;
  modelDurationMs?: number;
  missingSourceIds?: string[];
  compensationAction?: string;
  recoveryStrategy?: string | null;
}

export interface JobCompletionOptions {
  inputFingerprint?: string;
  outputFingerprint?: string;
  modelDurationMs?: number;
  missingSourceIds?: string[];
  compensationAction?: string;
  resultStatus?: string;
  noopReason?: string | null;
  recoveryStrategy?: string | null;
  denseIndexTelemetry?: {
    batchSize: number;
    batchLeaderJobId: string | null;
    physicalWorkAttributed: boolean;
    probeDurationMs: number;
    embeddingDurationMs: number;
    databaseWriteDurationMs: number;
    watermarkDurationMs: number;
    embeddingBatchCalls: number;
    watermarkDeferred: boolean;
  };
}

export interface OutboxEvent {
  id: string;
  userId: string;
  namespace: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseUntil: string | null;
  leaseOwner: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

export interface OutboxDispatchResult {
  processed: boolean;
  event: OutboxEvent | null;
  error?: string;
}

export interface EnqueueJobInput {
  id?: string;
  jobType: string;
  userId?: string;
  namespace?: string;
  payload?: Record<string, unknown>;
  requiredModelId?: string;
  requiredGenerationId?: string;
  priority?: number;
  maxAttempts?: number;
  availableAt?: string;
}

export interface ConsolidationSweepResult {
  scannedSessions: number;
  enqueued: number;
  summaryEnqueued: number;
  cutoff: string;
}

export interface MemoryCandidateInput {
  kind: MemoryKind;
  subject: string;
  predicate: string;
  value: string;
  content: string;
  confidence: number;
  importance: number;
  sensitivity?: Sensitivity;
  negated?: boolean;
  scopeType?: MemoryScopeType;
  scopeKey?: string;
  claimOccurredAt?: string | null;
  claimValidFrom?: string | null;
  claimValidTo?: string | null;
  sourceExcerpt?: string;
  sourceAuthority?: SourceAuthority;
  state?: CandidateState;
  decisionReason?: string;
}

export interface MemoryCandidate {
  id: string;
  userId: string;
  namespace: string;
  turnId: string | null;
  extractionRunId: string | null;
  reflectionRunId: string | null;
  candidateOrigin:
    | 'turn_extraction'
    | 'history_reextract'
    | 'reflection';
  claimFingerprint: string | null;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  value: string;
  normalizedKey: string;
  normalizedHash: string;
  stableKey: string;
  content: string;
  confidence: number;
  importance: number;
  sensitivity: Sensitivity;
  negated: boolean;
  scopeType: MemoryScopeType;
  scopeKey: string;
  claimOccurredAt: string | null;
  claimValidFrom: string | null;
  claimValidTo: string | null;
  sourceExcerpt: string | null;
  sourceAuthority: SourceAuthority;
  extractorId: string;
  extractorVersion: string;
  extractionModel: string;
  extractionPromptVersion: string;
  state: CandidateState;
  decisionReason: string | null;
  explicitCorrection: boolean;
  resolvedMemoryItemId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function cleanText(value: string | undefined, fallback = ''): string {
  return (value || fallback).normalize('NFKC').trim();
}

function evidenceText(
  value: string | undefined,
  fallback = '',
): string {
  return (value || fallback).trim();
}

function scopeEvidenceForCandidate(
  turnContent: string,
  requestedExcerpt: string,
): string {
  if (!requestedExcerpt) return turnContent;
  const excerptIndex = turnContent.indexOf(requestedExcerpt);
  if (
    excerptIndex < 0 ||
    turnContent.indexOf(
      requestedExcerpt,
      excerptIndex + requestedExcerpt.length,
    ) >= 0
  ) {
    return requestedExcerpt;
  }

  const sentenceBoundary = /[。！？.!?\n]/u;
  const prefix = turnContent.slice(0, excerptIndex);
  let sentenceStart = 0;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    if (sentenceBoundary.test(prefix[index] || '')) {
      sentenceStart = index + 1;
      break;
    }
  }
  const suffixStart = excerptIndex + requestedExcerpt.length;
  const suffix = turnContent.slice(suffixStart);
  const boundaryOffset = suffix.search(sentenceBoundary);
  const sentenceEnd = boundaryOffset < 0
    ? turnContent.length
    : suffixStart + boundaryOffset;
  return turnContent.slice(sentenceStart, sentenceEnd).trim() ||
    requestedExcerpt;
}

function parseTimestamp(
  value: string | undefined,
  fallback: string,
  field: string,
): string {
  if (!value) return fallback;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} 必须是有效的 ISO 日期时间`);
  }
  return new Date(timestamp).toISOString();
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function summaryBucketKeys(
  occurredAt: string,
  timezoneOffsetMinutes: number,
): { day: string; week: string } {
  const local = new Date(
    Date.parse(occurredAt) + timezoneOffsetMinutes * 60_000,
  );
  const day = local.toISOString().slice(0, 10);
  const thursday = new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  ));
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const weekYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNumber = Math.ceil(
    (((thursday.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7,
  );
  return {
    day,
    week: `${weekYear}-W${String(weekNumber).padStart(2, '0')}`,
  };
}

export function consolidationSweepSuccessorId(
  predecessorJobId: string,
): string {
  const predecessor = cleanText(predecessorJobId);
  if (!predecessor) {
    throw new Error('consolidation sweep predecessor 不能为空');
  }
  return `consolidation-sweep:${sha256(predecessor)}`;
}

export function isCanonicalConsolidationSweepJobId(
  jobId: string,
): boolean {
  return /^consolidation-sweep:(?:root|[a-f0-9]{64})$/u.test(
    cleanText(jobId),
  );
}

export function deadLetterRecoveryJobId(
  failedJobId: string,
  mode: DeadLetterRecoveryMode = 'recompute',
  generation = 1,
): string {
  const failed = cleanText(failedJobId);
  if (!failed) throw new Error('dead letter jobId 不能为空');
  if (!['recompute', 'repair', 'supersede'].includes(mode)) {
    throw new Error('dead letter 恢复模式无效');
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error('dead letter 恢复代际无效');
  }
  const base = mode === 'recompute'
    ? `dead-letter-recovery:${sha256(failed)}`
    : `dead-letter-recovery:${mode}:${sha256(failed)}`;
  return generation === 1 ? base : `${base}:${generation}`;
}

function normalizePart(value: string): string {
  return cleanText(value).toLocaleLowerCase('zh-CN');
}

function normalizeRoleAlias(value: unknown): string {
  return cleanText(asText(value))
    .toLocaleLowerCase('zh-CN')
    .replace(/(?:这个|该|此)?角色$/u, '')
    .replace(/\s+/gu, '');
}

function stableCandidateKey(
  subject: string,
  predicate: string,
): string {
  return `${normalizePart(subject)}::${normalizePart(predicate)}`;
}

function scopedStableCandidateKey(
  normalizedKey: string,
  scopeType: MemoryScopeType,
  scopeKey: string,
): string {
  return [
    normalizePart(scopeType),
    encodeURIComponent(scopeKey),
    normalizedKey,
  ].join('::');
}

function parseOptionalTimestamp(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} 必须是有效的 ISO 日期时间`);
  }
  return new Date(timestamp).toISOString();
}

const CORRECTION_PATTERN =
  /(?:纠正|更正|改(?:成|为|用)|换(?:成|为|用)|不再.{0,80}|不是.{0,80}而是|之前.{0,80}现在|现在(?:改用|换用)|其实.{0,80}(?:是|用)|(?:原则|偏好|要求|习惯|信息|决定|配置|做法).{0,12}(?:变了|改变(?:了)?|变更(?:了)?|更新(?:了)?))/iu;

const MEMORY_SCOPE_TYPES: MemoryScopeType[] = [
  'personal',
  'project',
  'role',
  'session',
];

function parseJson(
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid internal metadata is treated as empty and remains observable
    // through database integrity checks.
  }
  return {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}

interface NormalizedConversationIdentity {
  personaId: string | null;
  projectId: string | null;
  identitySource: string;
  identityStatus: ConversationIdentityStatus;
  roundId: string | null;
}

function normalizeConversationIdentity(input: {
  personaId?: string | null;
  projectId?: string | null;
  identitySource?: string;
  identityStatus?: ConversationIdentityStatus;
  roundId?: string | null;
}): NormalizedConversationIdentity {
  const identityStatus = input.identityStatus || 'legacy';
  const personaId = input.personaId ?? null;
  const projectId = input.projectId ?? null;
  if (personaId !== null && !isClientIdentityId(personaId)) {
    throw new Error('可信 personaId 格式无效');
  }
  if (projectId !== null && !isClientIdentityId(projectId)) {
    throw new Error('可信 projectId 格式无效');
  }
  const roundId = input.roundId ?? null;
  if (roundId !== null && !isClientIdentityId(roundId)) {
    throw new Error('可信 roundId 格式无效');
  }
  const identitySource = cleanText(
    input.identitySource,
    identityStatus === 'legacy' ? 'legacy' : 'unknown',
  );
  if (identityStatus === 'degraded') {
    throw new Error('身份上下文降级时禁止写入会话');
  }
  if (
    identityStatus === 'complete' &&
    (!personaId || !roundId)
  ) {
    throw new Error('完整身份上下文必须包含 personaId 和 roundId');
  }
  if (
    identityStatus === 'legacy' &&
    (personaId !== null || roundId !== null || projectId !== null)
  ) {
    throw new Error(
      'legacy 会话不能携带 personaId、projectId 或 roundId',
    );
  }
  return {
    personaId,
    projectId,
    identitySource,
    identityStatus,
    roundId,
  };
}

function assertSessionIdentity(
  session: DatabaseRow,
  namespace: string,
  identity: NormalizedConversationIdentity,
): void {
  if (asText(session.namespace) !== namespace) {
    throw new ConversationIdentityConflictError(
      '同一外部会话不能跨 namespace 复用',
    );
  }
  if (
    asText(session.identity_status) !== identity.identityStatus ||
    asNullableText(session.persona_id) !== identity.personaId
  ) {
    throw new ConversationIdentityConflictError(
      '同一外部会话不能切换 persona 或身份模式',
    );
  }
  if (asNullableText(session.project_id) !== identity.projectId) {
    throw new ConversationIdentityConflictError(
      '同一外部会话不能切换 project 绑定',
    );
  }
}

function rowToTurn(row: DatabaseRow): ConversationTurn {
  return {
    id: asText(row.id),
    sessionId: asText(row.session_id),
    userId: asText(row.user_id),
    namespace: asText(row.namespace),
    externalId: asText(row.external_id),
    role: asText(row.role) as TurnRole,
    content: asText(row.content),
    occurredAt: asText(row.occurred_at),
    createdAt: asText(row.created_at),
    metadata: parseJson(row.metadata_json),
  };
}

function rowToJob(row: DatabaseRow): MemoryJob {
  return {
    id: asText(row.id),
    jobType: asText(row.job_type),
    userId: asText(row.user_id),
    namespace: asText(row.namespace),
    payload: parseJson(row.payload_json),
    requiredModelId: asNullableText(row.required_model_id),
    requiredGenerationId: asNullableText(
      row.required_generation_id,
    ),
    status: asText(row.status) as MemoryJob['status'],
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: asText(row.available_at),
    leaseUntil: asNullableText(row.lease_until),
    leaseOwner: asNullableText(row.lease_owner),
    lastError: asNullableText(row.last_error),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
  };
}

function rowToOutbox(row: DatabaseRow): OutboxEvent {
  return {
    id: asText(row.id),
    userId: asText(row.user_id),
    namespace: asText(row.namespace),
    aggregateType: asText(row.aggregate_type),
    aggregateId: asText(row.aggregate_id),
    eventType: asText(row.event_type),
    payload: parseJson(row.payload_json),
    status: asText(row.status) as OutboxEvent['status'],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: asText(row.available_at),
    leaseUntil: asNullableText(row.lease_until),
    leaseOwner: asNullableText(row.lease_owner),
    lastError: asNullableText(row.last_error),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
    processedAt: asNullableText(row.processed_at),
  };
}

function rowToCandidate(row: DatabaseRow): MemoryCandidate {
  return {
    id: asText(row.id),
    userId: asText(row.user_id),
    namespace: asText(row.namespace),
    turnId: asNullableText(row.turn_id),
    extractionRunId: asNullableText(row.extraction_run_id),
    reflectionRunId: asNullableText(row.reflection_run_id),
    candidateOrigin:
      (asText(row.candidate_origin) as MemoryCandidate['candidateOrigin']) ||
      'turn_extraction',
    claimFingerprint: asNullableText(row.claim_fingerprint),
    kind: asText(row.kind) as MemoryKind,
    subject: asText(row.subject),
    predicate: asText(row.predicate),
    value: asText(row.value_text),
    normalizedKey: asText(row.normalized_key),
    normalizedHash: asText(row.normalized_hash),
    stableKey: asText(row.stable_key),
    content: asText(row.content),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    sensitivity: asText(row.sensitivity) as Sensitivity,
    negated: Number(row.negated) === 1,
    scopeType:
      (asText(row.scope_type) as MemoryScopeType) || 'personal',
    scopeKey: asText(row.scope_key) || 'self',
    claimOccurredAt: asNullableText(row.claim_occurred_at),
    claimValidFrom: asNullableText(row.claim_valid_from),
    claimValidTo: asNullableText(row.claim_valid_to),
    sourceExcerpt: asNullableText(row.source_excerpt),
    sourceAuthority:
      (asText(row.source_authority) as SourceAuthority) ||
      'legacy_unknown',
    extractorId: asText(row.extractor_id) || 'memory-extractor',
    extractorVersion: asText(row.extractor_version) || 'v1',
    extractionModel: asText(row.extraction_model) || 'unknown',
    extractionPromptVersion:
      asText(row.extraction_prompt_version) || 'unknown',
    state: asText(row.state) as CandidateState,
    decisionReason: asNullableText(row.decision_reason),
    explicitCorrection: Number(row.explicit_correction) === 1,
    resolvedMemoryItemId: asNullableText(row.resolved_memory_item_id),
    resolvedAt: asNullableText(row.resolved_at),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
  };
}

export class LifecycleStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  ensureSessionIdentityBinding(
    input: EnsureConversationSessionInput,
    beforeCommit?: () => void,
  ): void {
    const timestamp = this.now();
    const userId = cleanText(input.userId, config.defaultUserId);
    const namespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    const identity = normalizeConversationIdentity(input);
    const clientName = cleanText(input.clientName);
    const sessionExternalId = cleanText(input.sessionExternalId);
    if (
      identity.identityStatus === 'complete' &&
      !isClientIdentityId(input.sessionExternalId)
    ) {
      throw new Error('可信 sessionExternalId 格式无效');
    }
    const startedAt = parseTimestamp(
      input.startedAt,
      timestamp,
      'startedAt',
    );
    if (!clientName) throw new Error('clientName 不能为空');
    if (!sessionExternalId) throw new Error('sessionExternalId 不能为空');

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO conversation_sessions (
             id, user_id, namespace, client_name, external_id,
             persona_id, project_id, identity_source, identity_status,
             started_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, client_name, external_id) DO NOTHING`,
        )
        .run(
          randomUUID(),
          userId,
          namespace,
          clientName,
          sessionExternalId,
          identity.personaId,
          identity.projectId,
          identity.identitySource,
          identity.identityStatus,
          startedAt,
          JSON.stringify({
            trustedProjectId: identity.projectId,
          }),
        );
      const session = this.database
        .prepare(
          `SELECT *
           FROM conversation_sessions
           WHERE user_id = ? AND client_name = ? AND external_id = ?`,
        )
        .get(
          userId,
          clientName,
          sessionExternalId,
        ) as DatabaseRow | undefined;
      if (!session) throw new Error('无法创建或读取会话身份绑定');
      assertSessionIdentity(session, namespace, identity);
      beforeCommit?.();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordTurn(input: RecordTurnInput): RecordTurnResult {
    const timestamp = this.now();
    const userId = cleanText(input.userId, config.defaultUserId);
    const namespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    const identity = normalizeConversationIdentity(input);
    const clientName = cleanText(input.clientName);
    const sessionExternalId = cleanText(input.sessionExternalId);
    if (
      identity.identityStatus === 'complete' &&
      !isClientIdentityId(input.sessionExternalId)
    ) {
      throw new Error('可信 sessionExternalId 格式无效');
    }
    const turnExternalId = cleanText(input.turnExternalId);
    const content = evidenceText(input.content);
    if (!clientName) throw new Error('clientName 不能为空');
    if (!sessionExternalId) throw new Error('sessionExternalId 不能为空');
    if (!turnExternalId) throw new Error('turnExternalId 不能为空');
    if (!content) throw new Error('turn content 不能为空');
    if (!['system', 'user', 'assistant', 'tool'].includes(input.role)) {
      throw new Error('无效的 turn role');
    }
    const occurredAt = parseTimestamp(
      input.occurredAt,
      timestamp,
      'occurredAt',
    );
    const contentHash = sha256(`${input.role}\n${content}`);
    const metadata = JSON.stringify(input.metadata || {});

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO conversation_sessions (
             id, user_id, namespace, client_name, external_id,
             persona_id, project_id, identity_source, identity_status,
             started_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, client_name, external_id) DO NOTHING`,
        )
        .run(
          randomUUID(),
          userId,
          namespace,
          clientName,
          sessionExternalId,
          identity.personaId,
          identity.projectId,
          identity.identitySource,
          identity.identityStatus,
          occurredAt,
          metadata,
        );
      const session = this.database
        .prepare(
          `SELECT *
           FROM conversation_sessions
           WHERE user_id = ? AND client_name = ? AND external_id = ?`,
        )
        .get(
          userId,
          clientName,
          sessionExternalId,
        ) as DatabaseRow | undefined;
      if (!session) throw new Error('无法创建或读取会话');
      assertSessionIdentity(session, namespace, identity);
      const sessionId = asText(session.id);
      const turnId = randomUUID();
      const inserted = this.database
        .prepare(
          `INSERT INTO conversation_turns (
             id, session_id, user_id, namespace, external_id, role,
             content, content_hash, occurred_at, created_at, metadata_json,
             round_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, external_id) DO NOTHING`,
        )
        .run(
          turnId,
          sessionId,
          userId,
          namespace,
          turnExternalId,
          input.role,
          content,
          contentHash,
          occurredAt,
          timestamp,
          metadata,
          identity.roundId,
        );
      const created = Number(inserted.changes) === 1;
      const row = this.database
        .prepare(
          `SELECT *
           FROM conversation_turns
           WHERE session_id = ? AND external_id = ?`,
        )
        .get(sessionId, turnExternalId) as DatabaseRow | undefined;
      if (!row) throw new Error('无法创建或读取会话回合');
      if (
        asText(row.role) !== input.role ||
        asText(row.content_hash) !== contentHash ||
        asNullableText(row.round_id) !== identity.roundId
      ) {
        throw new Error('同一 turnExternalId 对应了不同内容');
      }

      if (created && input.role === 'user') {
        const persistedTurnId = asText(row.id);
        this.database
          .prepare(
            `INSERT INTO outbox_events (
               id, aggregate_type, aggregate_id, event_type,
               payload_json, available_at, created_at, user_id, namespace
             ) VALUES (
               ?, 'turn', ?, 'turn.recorded', ?, ?, ?, ?, ?
             )
             ON CONFLICT(
               aggregate_type, aggregate_id, event_type
             ) DO NOTHING`,
          )
          .run(
            `turn:${persistedTurnId}:recorded`,
            persistedTurnId,
            JSON.stringify({ turnId: persistedTurnId }),
            timestamp,
            timestamp,
            userId,
            namespace,
          );
      }

      this.database.exec('COMMIT');
      return {
        turn: rowToTurn(row),
        created,
        sessionId,
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  resolveLineage(input: {
    userId?: string;
    namespace?: string;
    clientName: string;
    fingerprint: string;
    keyType: 'exact' | 'suffix';
    messageCount: number;
  }): string | null {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT s.external_id
         FROM conversation_lineage_keys l
         JOIN conversation_sessions s ON s.id = l.session_id
         WHERE s.user_id = ?
           AND s.namespace = ?
           AND s.client_name = ?
           AND s.ended_at IS NULL
           AND l.fingerprint = ?
           AND l.key_type = ?
           AND l.message_count = ?
         ORDER BY s.started_at DESC
         LIMIT 2`,
      )
      .all(
        cleanText(input.userId, config.defaultUserId),
        cleanText(input.namespace, config.defaultNamespace),
        cleanText(input.clientName),
        cleanText(input.fingerprint),
        input.keyType,
        Math.max(1, Math.trunc(input.messageCount)),
      ) as DatabaseRow[];
    return rows.length === 1 ? asText(rows[0].external_id) : null;
  }

  recordCompletedExchange(
    input: RecordCompletedExchangeInput,
  ): RecordCompletedExchangeResult {
    const timestamp = this.now();
    const userId = cleanText(input.userId, config.defaultUserId);
    const namespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    const identity = normalizeConversationIdentity(input);
    const clientName = cleanText(input.clientName);
    const sessionExternalId = cleanText(input.sessionExternalId);
    if (
      identity.identityStatus === 'complete' &&
      !isClientIdentityId(input.sessionExternalId)
    ) {
      throw new Error('可信 sessionExternalId 格式无效');
    }
    const userTurnExternalId = cleanText(input.userTurnExternalId);
    const assistantTurnExternalId = cleanText(
      input.assistantTurnExternalId,
    );
    const userContent = evidenceText(input.userContent);
    const assistantContent = evidenceText(input.assistantContent);
    if (!clientName) throw new Error('clientName 不能为空');
    if (!sessionExternalId) throw new Error('sessionExternalId 不能为空');
    if (!userTurnExternalId) throw new Error('用户 turnExternalId 不能为空');
    if (!assistantTurnExternalId) {
      throw new Error('助手 turnExternalId 不能为空');
    }
    if (!userContent) throw new Error('用户 turn content 不能为空');
    if (!assistantContent) throw new Error('助手 turn content 不能为空');
    const occurredAt = parseTimestamp(
      input.occurredAt,
      timestamp,
      'occurredAt',
    );
    const userMetadata = JSON.stringify(input.userMetadata || {});
    const assistantMetadata = JSON.stringify(
      input.assistantMetadata || {},
    );

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO conversation_sessions (
             id, user_id, namespace, client_name, external_id,
             persona_id, project_id, identity_source, identity_status,
             started_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, client_name, external_id) DO NOTHING`,
        )
        .run(
          randomUUID(),
          userId,
          namespace,
          clientName,
          sessionExternalId,
          identity.personaId,
          identity.projectId,
          identity.identitySource,
          identity.identityStatus,
          occurredAt,
          userMetadata,
        );
      const session = this.database
        .prepare(
          `SELECT *
           FROM conversation_sessions
           WHERE user_id = ? AND client_name = ? AND external_id = ?`,
        )
        .get(
          userId,
          clientName,
          sessionExternalId,
        ) as DatabaseRow | undefined;
      if (!session) throw new Error('无法创建或读取会话');
      assertSessionIdentity(session, namespace, identity);
      const sessionId = asText(session.id);
      const insertTurn = (
        role: 'user' | 'assistant',
        externalId: string,
        content: string,
        metadata: string,
      ): { row: DatabaseRow; created: boolean } => {
        const contentHash = sha256(`${role}\n${content}`);
        const inserted = this.database
          .prepare(
            `INSERT INTO conversation_turns (
               id, session_id, user_id, namespace, external_id, role,
               content, content_hash, occurred_at, created_at,
               metadata_json, round_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, external_id) DO NOTHING`,
          )
          .run(
            randomUUID(),
            sessionId,
            userId,
            namespace,
            externalId,
            role,
            content,
            contentHash,
            occurredAt,
            timestamp,
            metadata,
            identity.roundId,
          );
        const row = this.database
          .prepare(
            `SELECT *
             FROM conversation_turns
             WHERE session_id = ? AND external_id = ?`,
          )
          .get(sessionId, externalId) as DatabaseRow | undefined;
        if (!row) throw new Error('无法创建或读取会话回合');
        if (
          asText(row.role) !== role ||
          asText(row.content_hash) !== contentHash ||
          asNullableText(row.round_id) !== identity.roundId
        ) {
          throw new Error('同一 turnExternalId 对应了不同内容');
        }
        return {
          row,
          created: Number(inserted.changes) === 1,
        };
      };

      const user = insertTurn(
        'user',
        userTurnExternalId,
        userContent,
        userMetadata,
      );
      const assistant = insertTurn(
        'assistant',
        assistantTurnExternalId,
        assistantContent,
        assistantMetadata,
      );
      const preRecordedExplicitUser =
        !user.created &&
        assistant.created &&
        parseJson(user.row.metadata_json).skipAutoExtraction === true;
      if (
        user.created !== assistant.created &&
        !preRecordedExplicitUser
      ) {
        throw new Error('完整对话回合出现部分重复，已拒绝落账');
      }

      if (assistant.created) {
        const userTurnId = asText(user.row.id);
        const assistantTurnId = asText(assistant.row.id);
        this.database
          .prepare(
            `INSERT INTO outbox_events (
               id, aggregate_type, aggregate_id, event_type,
               payload_json, available_at, created_at, user_id, namespace
             ) VALUES (
               ?, 'turn', ?, 'turn.completed', ?, ?, ?, ?, ?
             )
             ON CONFLICT(
               aggregate_type, aggregate_id, event_type
             ) DO NOTHING`,
          )
          .run(
            `turn:${userTurnId}:completed`,
            userTurnId,
            JSON.stringify({ userTurnId, assistantTurnId }),
            timestamp,
            timestamp,
            userId,
            namespace,
          );
        for (const event of input.toolEvents || []) {
          const callId = cleanText(event.callId);
          const toolName = cleanText(event.toolName);
          if (!callId || !toolName) continue;
          this.database
            .prepare(
              `INSERT INTO turn_tool_events (
                 id, session_id, user_turn_id, call_id, tool_name,
                 arguments_hash, result_hash, result_status, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(session_id, call_id) DO NOTHING`,
            )
            .run(
              randomUUID(),
              sessionId,
              userTurnId,
              callId,
              toolName,
              cleanText(event.argumentsHash) || null,
              cleanText(event.resultHash) || null,
              event.resultStatus,
              timestamp,
            );
        }

        if ((input.lineageKeys || []).length > 0) {
          this.database
            .prepare(
              'DELETE FROM conversation_lineage_keys WHERE session_id = ?',
            )
            .run(sessionId);
          for (const key of input.lineageKeys || []) {
            const fingerprint = cleanText(key.fingerprint);
            if (!fingerprint) continue;
            this.database
              .prepare(
                `INSERT INTO conversation_lineage_keys (
                   session_id, fingerprint, key_type, message_count,
                   updated_at
                 ) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(
                   session_id, fingerprint, key_type
                 ) DO UPDATE SET
                   message_count = excluded.message_count,
                   updated_at = excluded.updated_at`,
              )
              .run(
                sessionId,
                fingerprint,
                key.keyType,
                Math.max(1, Math.trunc(key.messageCount)),
                timestamp,
              );
          }
        }
      }

      this.database.exec('COMMIT');
      return {
        sessionId,
        userTurn: rowToTurn(user.row),
        assistantTurn: rowToTurn(assistant.row),
        created: assistant.created,
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  endSession(
    userId: string,
    clientName: string,
    sessionExternalId: string,
  ): void {
    const timestamp = this.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const session = this.database
        .prepare(
          `SELECT id
           FROM conversation_sessions
           WHERE user_id = ? AND client_name = ? AND external_id = ?`,
        )
        .get(
          cleanText(userId, config.defaultUserId),
          cleanText(clientName),
          cleanText(sessionExternalId),
        ) as DatabaseRow | undefined;
      if (!session) throw new Error('会话不存在');
      this.database
        .prepare(
          `UPDATE conversation_sessions
           SET ended_at = COALESCE(ended_at, ?)
           WHERE id = ?`,
        )
        .run(timestamp, asText(session.id));
      this.enqueueSessionConsolidationJobs(
        asText(session.id),
        'ended',
        timestamp,
      );
      this.enqueueSessionSummaryJobs(
        asText(session.id),
        'ended',
        timestamp,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  enqueueConsolidationSweep(
    availableAt = this.now(),
    predecessorJobId?: string,
  ): MemoryJob {
    const scheduledAt = parseTimestamp(
      availableAt,
      this.now(),
      'availableAt',
    );
    const id = predecessorJobId
      ? consolidationSweepSuccessorId(predecessorJobId)
      : 'consolidation-sweep:root';
    return this.enqueueJob({
      id,
      jobType: 'consolidation_sweep',
      userId: SYSTEM_JOB_USER_ID,
      namespace: SYSTEM_JOB_NAMESPACE,
      payload: { scheduledAt },
      priority: -10,
      maxAttempts: 5,
      availableAt: scheduledAt,
    });
  }

  ensureConsolidationSweep(
    availableAt = this.now(),
  ): MemoryJob {
    const timestamp = parseTimestamp(
      availableAt,
      this.now(),
      'availableAt',
    );
    const currentTimestamp = this.now();
    const nowMs = Date.parse(currentTimestamp);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const sweeps = (
        this.database
          .prepare(
            `SELECT *
             FROM memory_jobs
             WHERE job_type = 'consolidation_sweep'
               AND user_id = ? AND namespace = ?
             ORDER BY created_at DESC, id DESC`,
          )
          .all(
            SYSTEM_JOB_USER_ID,
            SYSTEM_JOB_NAMESPACE,
          ) as DatabaseRow[]
      )
        .map(rowToJob)
        .filter((job) => isCanonicalConsolidationSweepJobId(job.id));
      const active = sweeps.find((job) => {
        if (
          (job.status === 'pending' || job.status === 'failed') &&
          job.attempts < job.maxAttempts
        ) {
          return true;
        }
        if (job.status !== 'running') return false;
        if (job.attempts < job.maxAttempts) return true;
        return Boolean(
          job.leaseUntil && Date.parse(job.leaseUntil) > nowMs,
        );
      });
      const predecessor = sweeps[0];
      const occupiedRoot = this.getJob('consolidation-sweep:root');
      const takeover = active || (
        predecessor
          ? this.enqueueConsolidationSweep(
              timestamp,
              predecessor.id,
            )
          : occupiedRoot
            ? this.enqueueConsolidationSweep(
                timestamp,
                [
                  'bootstrap',
                  SYSTEM_JOB_USER_ID,
                  SYSTEM_JOB_NAMESPACE,
                ].join(':'),
              )
            : this.enqueueConsolidationSweep(timestamp)
      );
      const legacyRows = this.database
        .prepare(
          `SELECT id
           FROM memory_jobs
           WHERE job_type = 'consolidation_sweep'
             AND (user_id != ? OR namespace != ?)
             AND status IN ('pending', 'failed', 'running')`,
        )
        .all(
          SYSTEM_JOB_USER_ID,
          SYSTEM_JOB_NAMESPACE,
        ) as DatabaseRow[];
      const retireLegacy = this.database.prepare(
        `UPDATE memory_jobs
         SET status = 'completed', lease_until = NULL,
             lease_owner = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND job_type = 'consolidation_sweep'
           AND (
             status IN ('pending', 'failed')
             OR (
               status = 'running'
               AND (lease_until IS NULL OR lease_until <= ?)
             )
           )`,
      );
      for (const row of legacyRows) {
        const legacyId = asText(row.id);
        if (!isCanonicalConsolidationSweepJobId(legacyId)) continue;
        retireLegacy.run(
          `由稳定系统 consolidation sweep 链接管：${takeover.id}`,
          currentTimestamp,
          legacyId,
          currentTimestamp,
        );
      }
      this.database.exec('COMMIT');
      return takeover;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  runConsolidationSweep(
    input: {
      at?: string;
      idleMinutes?: number;
    } = {},
  ): ConsolidationSweepResult {
    const timestamp = parseTimestamp(
      input.at,
      this.now(),
      'at',
    );
    const idleMinutes = Math.max(
      1,
      Math.min(
        Math.trunc(
          input.idleMinutes ?? config.consolidationIdleMinutes,
        ),
        1_440,
      ),
    );
    const cutoff = new Date(
      Date.parse(timestamp) - idleMinutes * 60_000,
    ).toISOString();
    const sessions = this.database
      .prepare(
        `SELECT s.id
         FROM conversation_sessions s
         JOIN conversation_turns t ON t.session_id = s.id
         WHERE s.ended_at IS NULL
         GROUP BY s.id
         HAVING MAX(t.created_at) <= ?
         ORDER BY MAX(t.created_at) ASC, s.id ASC`,
      )
      .all(cutoff) as DatabaseRow[];
    let enqueued = 0;
    let summaryEnqueued = 0;
    for (const session of sessions) {
      enqueued += this.enqueueSessionConsolidationJobs(
        asText(session.id),
        'idle',
        timestamp,
      );
      summaryEnqueued += this.enqueueSessionSummaryJobs(
        asText(session.id),
        'idle',
        timestamp,
      );
    }
    return {
      scannedSessions: sessions.length,
      enqueued,
      summaryEnqueued,
      cutoff,
    };
  }

  enqueueEndedSessionSummaryJobs(
    sessionId: string,
    timestamp = this.now(),
  ): number {
    const normalizedSessionId = cleanText(sessionId);
    const ended = this.database.prepare(
      `SELECT ended_at FROM conversation_sessions WHERE id = ?`,
    ).get(normalizedSessionId) as DatabaseRow | undefined;
    if (!ended || !asNullableText(ended.ended_at)) return 0;
    return this.enqueueSessionSummaryJobs(
      normalizedSessionId,
      'episode_materialized',
      parseTimestamp(timestamp, this.now(), 'timestamp'),
    );
  }

  listTurns(sessionId: string): ConversationTurn[] {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM conversation_turns
           WHERE session_id = ?
           ORDER BY occurred_at ASC, created_at ASC`,
        )
        .all(cleanText(sessionId)) as DatabaseRow[]
    ).map(rowToTurn);
  }

  recentTurnsForExternalSession(input: {
    userId: string;
    namespace: string;
    clientName: string;
    sessionExternalId: string;
    limit: number;
  }): ConversationTurn[] {
    const rows = this.database
      .prepare(
        `SELECT t.*
         FROM conversation_sessions s
         JOIN conversation_turns t ON t.session_id = s.id
         WHERE s.user_id = ?
           AND s.namespace = ?
           AND s.client_name = ?
           AND s.external_id = ?
           AND t.role IN ('user', 'assistant')
         ORDER BY t.occurred_at DESC, t.created_at DESC, t.id DESC
         LIMIT ?`,
      )
      .all(
        cleanText(input.userId),
        cleanText(input.namespace),
        cleanText(input.clientName),
        cleanText(input.sessionExternalId),
        Math.max(1, Math.min(24, Math.trunc(input.limit))),
      ) as DatabaseRow[];
    return rows.reverse().map(rowToTurn);
  }

  getTurn(
    turnId: string,
    userId?: string,
    namespace?: string,
  ): ConversationTurn | null {
    if ((userId === undefined) !== (namespace === undefined)) {
      throw new Error('getTurn 必须同时提供 userId 和 namespace');
    }
    const row = this.database
      .prepare(
        `SELECT *
         FROM conversation_turns
         WHERE id = ?
           ${userId === undefined
             ? ''
             : 'AND user_id = ? AND namespace = ?'}`,
      )
      .get(
        cleanText(turnId),
        ...(
          userId === undefined
            ? []
            : [cleanText(userId), cleanText(namespace)]
        ),
      ) as DatabaseRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  boundConversationScopes(
    input: BoundConversationScopeInput,
  ): MemoryAccessScope[] | null {
    const userId = cleanText(input.userId);
    const namespace = cleanText(input.namespace);
    const clientName = cleanText(input.clientName);
    const sessionExternalId = cleanText(input.sessionExternalId);
    if (!userId || !namespace || !clientName || !sessionExternalId) {
      throw new Error('可信会话作用域绑定参数不能为空');
    }
    const session = this.database.prepare(
      `SELECT external_id, persona_id, project_id, identity_status
       FROM conversation_sessions
       WHERE user_id = ? AND namespace = ?
         AND client_name = ? AND external_id = ?`,
    ).get(
      userId,
      namespace,
      clientName,
      sessionExternalId,
    ) as DatabaseRow | undefined;
    if (!session) return null;
    const scopes: MemoryAccessScope[] = [
      { scopeType: 'personal', scopeKey: 'self' },
    ];
    if (asText(session.identity_status) !== 'complete') return scopes;
    const personaId = asNullableText(session.persona_id);
    if (!personaId) {
      throw new Error('完整会话缺少可信 persona 绑定');
    }
    scopes.push(
      { scopeType: 'role', scopeKey: personaId },
      { scopeType: 'session', scopeKey: asText(session.external_id) },
    );
    const projectId = asNullableText(session.project_id);
    if (projectId) {
      scopes.push({ scopeType: 'project', scopeKey: projectId });
    }
    return scopes;
  }

  enqueueJob(input: EnqueueJobInput): MemoryJob {
    const timestamp = this.now();
    this.enqueueJobInternal(input, timestamp);
    return this.getJob(input.id || this.jobId(input))!;
  }

  recoverDeadLetterJob(
    failedJobId: string,
    userId: string,
    namespace: string,
    mode: DeadLetterRecoveryMode,
    reason?: string,
  ): MemoryJob {
    const jobId = cleanText(failedJobId);
    const ownerId = cleanText(userId);
    const expectedNamespace = cleanText(namespace);
    if (!jobId || !ownerId || !expectedNamespace) {
      throw new Error('dead letter jobId、userId 和 namespace 不能为空');
    }
    const timestamp = this.now();
    if (!['recompute', 'repair', 'supersede'].includes(mode)) {
      throw new Error('dead letter 恢复模式必须明确指定');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare(
          `SELECT j.*,
                  d.job_type AS dead_job_type,
                  d.user_id AS dead_user_id,
                  d.namespace AS dead_namespace,
                  d.payload_json AS dead_payload_json
           FROM dead_letter_jobs d
           JOIN memory_jobs j ON j.id = d.job_id
           WHERE d.job_id = ? AND d.user_id = ? AND d.namespace = ?
             AND j.user_id = ? AND j.namespace = ?`,
        )
        .get(
          jobId,
          ownerId,
          expectedNamespace,
          ownerId,
          expectedNamespace,
        ) as DatabaseRow | undefined;
      if (!row) throw new Error('dead letter 不存在或不属于当前账户');
      const original = rowToJob(row);
      const consistent =
        original.status === 'dead' &&
        original.jobType === asText(row.dead_job_type) &&
        original.userId === asText(row.dead_user_id) &&
        original.namespace === asText(row.dead_namespace) &&
        asText(row.payload_json) === asText(row.dead_payload_json);
      if (!consistent) {
        throw new Error('dead letter 与原始任务证据不一致');
      }
      if (
        original.jobType === 'consolidation_sweep' &&
        isCanonicalConsolidationSweepJobId(original.id) &&
        (
          original.userId !== SYSTEM_JOB_USER_ID ||
          original.namespace !== SYSTEM_JOB_NAMESPACE
        )
      ) {
        throw new Error('legacy 全局巩固 sweep 只能由稳定系统任务链接管');
      }
      const attemptAudit = this.database
        .prepare(
          `SELECT detail_json
           FROM audit_log
           WHERE user_id = ?
             AND action = 'job_attempt_failed'
             AND json_extract(detail_json, '$.jobId') = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(original.userId, original.id) as DatabaseRow | undefined;
      let failureClass: JobFailureClass = 'unknown';
      try {
        const detail = JSON.parse(
          asText(attemptAudit?.detail_json) || '{}',
        ) as Record<string, unknown>;
        const value = cleanText(asText(detail.failureClass));
        if (
          [
            'transient',
            'protocol',
            'coverage',
            'source_drift',
            'unsupported',
            'unknown',
          ].includes(value)
        ) {
          failureClass = value as JobFailureClass;
        }
      } catch {
        failureClass = 'unknown';
      }
      if (failureClass === 'unsupported' && mode !== 'supersede') {
        throw new Error('unsupported dead letter 只能 supersede，不能自动重放');
      }
      if (
        mode === 'repair' &&
        !['protocol', 'coverage'].includes(failureClass)
      ) {
        throw new Error('repair 仅适用于 protocol 或 coverage dead letter');
      }
      const previousRecoveryRows = this.database
        .prepare(
          `SELECT *
           FROM memory_jobs
           WHERE user_id = ? AND namespace = ?
             AND json_extract(payload_json, '$.recovery.failedJobId') = ?
             AND json_extract(payload_json, '$.recovery.mode') = ?
           ORDER BY CAST(COALESCE(
                      json_extract(payload_json, '$.recovery.generation'),
                      1
                    ) AS INTEGER) DESC,
                    created_at DESC, id DESC`,
        )
        .all(
          original.userId,
          original.namespace,
          original.id,
          mode,
        ) as DatabaseRow[];
      const latestRecovery = previousRecoveryRows[0]
        ? rowToJob(previousRecoveryRows[0])
        : null;
      if (latestRecovery && latestRecovery.status !== 'dead') {
        this.database.exec('COMMIT');
        return latestRecovery;
      }
      const priorRecoveryValue = latestRecovery?.payload.recovery;
      const priorRecovery =
        priorRecoveryValue &&
        typeof priorRecoveryValue === 'object' &&
        !Array.isArray(priorRecoveryValue)
          ? priorRecoveryValue as Record<string, unknown>
          : null;
      const parsedPreviousGeneration = Number(
        priorRecovery?.generation || 1,
      );
      const previousGeneration = latestRecovery
        ? Number.isInteger(parsedPreviousGeneration) &&
            parsedPreviousGeneration >= 1
          ? parsedPreviousGeneration
          : 1
        : 0;
      const generation = previousGeneration + 1;
      const recoveryId = deadLetterRecoveryJobId(
        original.id,
        mode,
        generation,
      );
      const recoveryPayload = {
        ...original.payload,
        recovery: {
          mode,
          failedJobId: original.id,
          failureClass,
          requestedAt: timestamp,
          reason: cleanText(reason) || null,
          strategy: mode === 'repair'
            ? failureClass === 'coverage'
              ? 'recompute_eligible_clusters_only'
              : 'single_attempt_protocol_repair'
            : mode === 'recompute'
              ? 'reload_current_sources_and_recompute'
              : 'acknowledge_and_supersede',
          ...(generation > 1
            ? {
                generation,
                previousRecoveryJobId: latestRecovery!.id,
              }
            : {}),
        },
      };
      const created = this.enqueueJobInternal({
        id: recoveryId,
        jobType: mode === 'supersede'
          ? 'dead_letter_supersede'
          : original.jobType,
        userId: original.userId,
        namespace: original.namespace,
        payload: recoveryPayload,
        requiredModelId: mode === 'supersede'
          ? undefined
          : original.requiredModelId || undefined,
        requiredGenerationId:
          mode === 'supersede'
            ? undefined
            : original.requiredGenerationId || undefined,
        priority: original.priority,
        maxAttempts: mode === 'repair'
          ? 1
          : Math.max(1, Math.min(3, original.maxAttempts)),
        availableAt: timestamp,
      }, timestamp);
      const recovery = this.getJob(recoveryId);
      if (!recovery) throw new Error('无法创建 dead letter 后继任务');
      const recoveryConsistent =
        recovery.jobType === (
          mode === 'supersede'
            ? 'dead_letter_supersede'
            : original.jobType
        ) &&
        recovery.userId === original.userId &&
        recovery.namespace === original.namespace &&
        JSON.stringify(recovery.payload) ===
          JSON.stringify(recoveryPayload) &&
        recovery.requiredModelId === (
          mode === 'supersede' ? null : original.requiredModelId
        ) &&
        recovery.requiredGenerationId ===
          (mode === 'supersede'
            ? null
            : original.requiredGenerationId) &&
        recovery.priority === original.priority &&
        recovery.maxAttempts === (
          mode === 'repair'
            ? 1
            : Math.max(1, Math.min(3, original.maxAttempts))
        );
      if (!recoveryConsistent) {
        throw new Error('dead letter 后继任务与原始失败证据不一致');
      }
      if (mode === 'supersede' && recovery.status !== 'completed') {
        this.database
          .prepare(
            `UPDATE memory_jobs
             SET status = 'completed', updated_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(timestamp, recovery.id);
      }
      if (created) {
        this.database
          .prepare(
            `INSERT INTO audit_log (
               id, action, memory_id, user_id, detail_json, created_at
             )
             SELECT COALESCE(MAX(id), 0) + 1,
                    'dead_letter_recovery_requested', NULL, ?, ?, ?
             FROM audit_log
             WHERE user_id = ?`,
          )
          .run(
            original.userId,
            JSON.stringify({
              failedJobId: original.id,
              recoveryJobId: recovery.id,
              mode,
              generation,
              failureClass,
              reason: cleanText(reason) || null,
              nextState: mode === 'supersede' ? 'completed' : 'pending',
            }),
            timestamp,
            original.userId,
          );
      }
      this.database.exec('COMMIT');
      return this.getJob(recoveryId)!;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  dispatchNextOutbox(
    workerId: string,
    leaseSeconds = 60,
  ): OutboxDispatchResult {
    const event = this.claimOutbox(workerId, leaseSeconds);
    if (!event) {
      return { processed: false, event: null };
    }
    try {
      this.enqueueOutboxJob(event);
      return {
        processed: true,
        event: this.completeOutbox(event.id, workerId),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        processed: true,
        event: this.failOutbox(
          event.id,
          workerId,
          message,
          Math.min(
            60_000,
            1000 * 2 ** Math.max(0, event.attempts - 1),
          ),
        ),
        error: message,
      };
    }
  }

  claimOutbox(
    workerId: string,
    leaseSeconds = 60,
  ): OutboxEvent | null {
    const owner = cleanText(workerId);
    if (!owner) throw new Error('workerId 不能为空');
    const timestamp = this.now();
    const leaseUntil = new Date(
      Date.parse(timestamp) + Math.max(1, leaseSeconds) * 1000,
    ).toISOString();

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare(
          `SELECT *
           FROM outbox_events
           WHERE (
             (status IN ('pending', 'failed') AND available_at <= ?)
             OR (status = 'processing' AND lease_until <= ?)
           )
             AND attempts < max_attempts
           ORDER BY available_at ASC, created_at ASC
           LIMIT 1`,
        )
        .get(timestamp, timestamp) as DatabaseRow | undefined;
      if (!row) {
        this.database.exec('COMMIT');
        return null;
      }
      const id = asText(row.id);
      this.database
        .prepare(
          `UPDATE outbox_events
           SET status = 'processing', attempts = attempts + 1,
               lease_until = ?, lease_owner = ?, last_error = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(leaseUntil, owner, timestamp, id);
      this.database.exec('COMMIT');
      return this.getOutbox(id);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  completeOutbox(eventId: string, workerId: string): OutboxEvent {
    const result = this.database
      .prepare(
        `UPDATE outbox_events
         SET status = 'completed', lease_until = NULL,
             lease_owner = NULL, processed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .run(
        this.now(),
        this.now(),
        cleanText(eventId),
        cleanText(workerId),
      );
    if (Number(result.changes) !== 1) {
      throw new Error('只有持有租约的 Worker 可以完成 outbox 事件');
    }
    return this.getOutbox(eventId)!;
  }

  failOutbox(
    eventId: string,
    workerId: string,
    error: string,
    retryDelayMs = 1000,
  ): OutboxEvent {
    const timestamp = this.now();
    const nextAvailable = new Date(
      Date.parse(timestamp) + Math.max(0, retryDelayMs),
    ).toISOString();
    const result = this.database
      .prepare(
        `UPDATE outbox_events
         SET status = 'failed', available_at = ?, lease_until = NULL,
             lease_owner = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .run(
        nextAvailable,
        cleanText(error, '未知错误'),
        timestamp,
        cleanText(eventId),
        cleanText(workerId),
      );
    if (Number(result.changes) !== 1) {
      throw new Error('只有持有租约的 Worker 可以失败 outbox 事件');
    }
    return this.getOutbox(eventId)!;
  }

  getOutbox(eventId: string): OutboxEvent | null {
    const row = this.database
      .prepare('SELECT * FROM outbox_events WHERE id = ?')
      .get(cleanText(eventId)) as DatabaseRow | undefined;
    return row ? rowToOutbox(row) : null;
  }

  claimJob(
    workerId: string,
    leaseSeconds = 60,
    jobTypes: string[] = [],
    capabilities?: {
      modelIds?: string[];
      generationIds?: string[];
    },
  ): MemoryJob | null {
    const owner = cleanText(workerId);
    if (!owner) throw new Error('workerId 不能为空');
    const timestamp = this.now();
    const leaseUntil = new Date(
      Date.parse(timestamp) + Math.max(1, leaseSeconds) * 1000,
    ).toISOString();
    const filters = [
      `(
        (status IN ('pending', 'failed') AND available_at <= ?)
        OR (status = 'running' AND lease_until <= ?)
      )`,
      'attempts < max_attempts',
    ];
    const values: SQLInputValue[] = [timestamp, timestamp];
    if (jobTypes.length > 0) {
      filters.push(
        `job_type IN (${jobTypes.map(() => '?').join(', ')})`,
      );
      values.push(...jobTypes.map((jobType) => cleanText(jobType)));
    }
    const modelIds = [
      ...new Set(
        (capabilities?.modelIds || [])
          .map((value) => cleanText(value))
          .filter(Boolean),
      ),
    ];
    const generationIds = [
      ...new Set(
        (capabilities?.generationIds || [])
          .map((value) => cleanText(value))
          .filter(Boolean),
      ),
    ];
    if (modelIds.length > 0) {
      filters.push(
        `(required_model_id IS NULL OR required_model_id IN (` +
        `${modelIds.map(() => '?').join(', ')}))`,
      );
      values.push(...modelIds);
    } else {
      filters.push('required_model_id IS NULL');
    }
    if (generationIds.length > 0) {
      filters.push(
        `(required_generation_id IS NULL OR ` +
        `required_generation_id IN (` +
        `${generationIds.map(() => '?').join(', ')}))`,
      );
      values.push(...generationIds);
    } else {
      filters.push('required_generation_id IS NULL');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const exhaustedRows = this.database
        .prepare(
          `SELECT *
           FROM memory_jobs
           WHERE status = 'running'
             AND (lease_until IS NULL OR lease_until <= ?)
             AND attempts >= max_attempts`,
        )
        .all(timestamp) as DatabaseRow[];
      const expireMessage = '任务租约过期且已耗尽最大尝试次数';
      const markDead = this.database.prepare(
        `UPDATE memory_jobs
         SET status = 'dead', lease_until = NULL, lease_owner = NULL,
             last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'
           AND (lease_until IS NULL OR lease_until <= ?)
           AND attempts >= max_attempts`,
      );
      const deadLetter = this.database.prepare(
        `INSERT INTO dead_letter_jobs (
           job_id, job_type, user_id, namespace, payload_json,
           attempts, last_error, failed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           attempts = excluded.attempts,
           last_error = excluded.last_error,
           failed_at = excluded.failed_at`,
      );
      for (const exhaustedRow of exhaustedRows) {
        const exhausted = rowToJob(exhaustedRow);
        const result = markDead.run(
          expireMessage,
          timestamp,
          exhausted.id,
          timestamp,
        );
        if (Number(result.changes) !== 1) continue;
        deadLetter.run(
          exhausted.id,
          exhausted.jobType,
          exhausted.userId,
          exhausted.namespace,
          JSON.stringify(exhausted.payload),
          exhausted.attempts,
          expireMessage,
          timestamp,
        );
      }
      const row = this.database
        .prepare(
          `SELECT *
           FROM memory_jobs
           WHERE ${filters.join(' AND ')}
           ORDER BY priority DESC, available_at ASC, created_at ASC
           LIMIT 1`,
        )
        .get(...values) as DatabaseRow | undefined;
      if (!row) {
        this.database.exec('COMMIT');
        return null;
      }
      const jobId = asText(row.id);
      this.database
        .prepare(
          `UPDATE memory_jobs
           SET status = 'running', attempts = attempts + 1,
               lease_until = ?, lease_owner = ?, last_error = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(leaseUntil, owner, timestamp, jobId);
      this.database.exec('COMMIT');
      return this.getJob(jobId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  claimDenseIndexBatch(
    seedJobId: string,
    workerId: string,
    leaseSeconds = 60,
    limit = 64,
  ): MemoryJob[] {
    const owner = cleanText(workerId);
    if (!owner) throw new Error('workerId 不能为空');
    const timestamp = this.now();
    const leaseUntil = new Date(
      Date.parse(timestamp) + Math.max(1, leaseSeconds) * 1000,
    ).toISOString();
    const batchLimit = Math.max(1, Math.min(Math.trunc(limit), 256));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const seedRow = this.database.prepare(
        `SELECT *
         FROM memory_jobs
         WHERE id = ? AND job_type = 'index_memory'
           AND status = 'running' AND lease_owner = ?
           AND lease_until > ?`,
      ).get(cleanText(seedJobId), owner, timestamp) as
        | DatabaseRow
        | undefined;
      if (!seedRow) {
        throw new Error('Dense 批量领取的种子任务租约无效');
      }
      const seed = rowToJob(seedRow);
      const extraRows = batchLimit > 1
        ? this.database.prepare(
            `SELECT *
             FROM memory_jobs
             WHERE id != ? AND job_type = 'index_memory'
               AND user_id = ? AND namespace = ?
               AND (
                 required_model_id = ?
                 OR (required_model_id IS NULL AND ? IS NULL)
               )
               AND (
                 required_generation_id = ?
                 OR (
                   required_generation_id IS NULL
                   AND ? IS NULL
                 )
               )
               AND (
                 (status IN ('pending', 'failed') AND available_at <= ?)
                 OR (status = 'running' AND lease_until <= ?)
               )
               AND attempts < max_attempts
             ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
             LIMIT ?`,
          ).all(
            seed.id,
            seed.userId,
            seed.namespace,
            seed.requiredModelId,
            seed.requiredModelId,
            seed.requiredGenerationId,
            seed.requiredGenerationId,
            timestamp,
            timestamp,
            batchLimit - 1,
          ) as DatabaseRow[]
        : [];
      const claim = this.database.prepare(
        `UPDATE memory_jobs
         SET status = 'running', attempts = attempts + 1,
             lease_until = ?, lease_owner = ?, last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
      );
      for (const row of extraRows) {
        claim.run(leaseUntil, owner, timestamp, asText(row.id));
      }
      this.database.exec('COMMIT');
      return [seed.id, ...extraRows.map((row) => asText(row.id))]
        .map((jobId) => this.getJob(jobId)!)
        .filter(Boolean);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  deferClaimedJob(
    jobId: string,
    workerId: string,
    retryDelayMs = 0,
    reason = 'foreground_priority',
  ): MemoryJob {
    const current = this.getJob(jobId);
    const owner = cleanText(workerId);
    if (
      !current ||
      current.status !== 'running' ||
      current.leaseOwner !== owner
    ) {
      throw new Error('只有持有租约的 Worker 可以归还任务');
    }
    const timestamp = this.now();
    const nextAvailable = new Date(
      Date.parse(timestamp) + Math.max(0, retryDelayMs),
    ).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(
          `UPDATE memory_jobs
           SET status = 'pending', available_at = ?,
               lease_until = NULL, lease_owner = NULL,
               attempts = MAX(0, attempts - 1),
               last_error = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(nextAvailable, timestamp, current.id, owner);
      if (Number(result.changes) !== 1) {
        throw new Error('任务租约已变化，无法安全归还');
      }
      this.database
        .prepare(
          `INSERT INTO audit_log (
             id, action, memory_id, user_id, detail_json, created_at
           )
           SELECT COALESCE(MAX(id), 0) + 1,
                  'job_claim_deferred', NULL, ?, ?, ?
           FROM audit_log
           WHERE user_id = ?`,
        )
        .run(
          current.userId,
          JSON.stringify({
            jobId: current.id,
            jobType: current.jobType,
            namespace: current.namespace,
            attemptRestoredTo: Math.max(0, current.attempts - 1),
            reason: cleanText(reason, 'foreground_priority'),
            nextAvailable,
          }),
          timestamp,
          current.userId,
        );
      this.database.exec('COMMIT');
      return this.getJob(current.id)!;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  completeJob(
    jobId: string,
    workerId: string,
    options: JobCompletionOptions = {},
  ): MemoryJob {
    const current = this.getJob(jobId);
    const owner = cleanText(workerId);
    if (
      !current ||
      current.status !== 'running' ||
      current.leaseOwner !== owner
    ) {
      throw new Error('只有持有租约的 Worker 可以完成任务');
    }
    const timestamp = this.now();
    const inputFingerprint = cleanText(options.inputFingerprint) ||
      sha256(JSON.stringify({
        jobType: current.jobType,
        userId: current.userId,
        namespace: current.namespace,
        payload: current.payload,
        requiredModelId: current.requiredModelId,
        requiredGenerationId: current.requiredGenerationId,
      }));
    const outputFingerprint =
      asNullableText(options.outputFingerprint) || null;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(
          `UPDATE memory_jobs
           SET status = 'completed', lease_until = NULL,
               lease_owner = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(timestamp, current.id, owner);
      if (Number(result.changes) !== 1) {
        throw new Error('只有持有租约的 Worker 可以完成任务');
      }
      this.database
        .prepare(
          `INSERT INTO audit_log (
             id, action, memory_id, user_id, detail_json, created_at
           )
           SELECT COALESCE(MAX(id), 0) + 1,
                  'job_attempt_completed', NULL, ?, ?, ?
           FROM audit_log
           WHERE user_id = ?`,
        )
        .run(
          current.userId,
          JSON.stringify({
            jobId: current.id,
            jobType: current.jobType,
            namespace: current.namespace,
            attempt: current.attempts,
            maxAttempts: current.maxAttempts,
            inputFingerprint,
            outputFingerprint,
            modelDurationMs: Number.isFinite(options.modelDurationMs)
              ? Math.max(0, Number(options.modelDurationMs))
              : null,
            missingSourceIds: [...new Set(
              (options.missingSourceIds || [])
                .map((value) => cleanText(value))
                .filter(Boolean),
            )].sort(),
            compensationAction:
              asNullableText(options.compensationAction) || null,
            recoveryStrategy:
              asNullableText(options.recoveryStrategy) || null,
            resultStatus:
              cleanText(options.resultStatus) || 'completed',
            noopReason: asNullableText(options.noopReason) || null,
            denseIndexTelemetry: options.denseIndexTelemetry
              ? {
                  batchSize: Math.max(
                    0,
                    Math.trunc(options.denseIndexTelemetry.batchSize),
                  ),
                  batchLeaderJobId: asNullableText(
                    options.denseIndexTelemetry.batchLeaderJobId,
                  ),
                  physicalWorkAttributed:
                    options.denseIndexTelemetry.physicalWorkAttributed ===
                    true,
                  probeDurationMs: Math.max(
                    0,
                    Number(options.denseIndexTelemetry.probeDurationMs) || 0,
                  ),
                  embeddingDurationMs: Math.max(
                    0,
                    Number(
                      options.denseIndexTelemetry.embeddingDurationMs,
                    ) || 0,
                  ),
                  databaseWriteDurationMs: Math.max(
                    0,
                    Number(
                      options.denseIndexTelemetry.databaseWriteDurationMs,
                    ) || 0,
                  ),
                  watermarkDurationMs: Math.max(
                    0,
                    Number(
                      options.denseIndexTelemetry.watermarkDurationMs,
                    ) || 0,
                  ),
                  embeddingBatchCalls: Math.max(
                    0,
                    Math.trunc(
                      options.denseIndexTelemetry.embeddingBatchCalls,
                    ),
                  ),
                  watermarkDeferred:
                    options.denseIndexTelemetry.watermarkDeferred === true,
                }
              : null,
            nextState: 'completed',
          }),
          timestamp,
          current.userId,
        );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.getJob(current.id)!;
  }

  failJob(
    jobId: string,
    workerId: string,
    error: string,
    retryDelayMs = 1000,
    options: JobFailureOptions = {},
  ): MemoryJob {
    const current = this.getJob(jobId);
    const owner = cleanText(workerId);
    if (
      !current ||
      current.status !== 'running' ||
      current.leaseOwner !== owner
    ) {
      throw new Error('只有持有租约的 Worker 可以失败任务');
    }
    const timestamp = this.now();
    const message = cleanText(error, '未知错误');
    const failureClass = options.failureClass || 'unknown';
    const inputFingerprint = cleanText(options.inputFingerprint) ||
      sha256(JSON.stringify({
        jobType: current.jobType,
        userId: current.userId,
        namespace: current.namespace,
        payload: current.payload,
        requiredModelId: current.requiredModelId,
        requiredGenerationId: current.requiredGenerationId,
      }));
    const outputFingerprint =
      cleanText(options.outputFingerprint) || null;
    const errorFingerprint = sha256(message);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const previousAudit = this.database
        .prepare(
          `SELECT detail_json
           FROM audit_log
           WHERE user_id = ?
             AND action = 'job_attempt_failed'
             AND json_extract(detail_json, '$.jobId') = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(current.userId, current.id) as DatabaseRow | undefined;
      let repeatedFingerprint = false;
      try {
        const previous = JSON.parse(
          asText(previousAudit?.detail_json) || '{}',
        ) as Record<string, unknown>;
        repeatedFingerprint =
          !['transient', 'source_drift'].includes(failureClass) &&
          asText(previous.failureClass) === failureClass &&
          asText(previous.inputFingerprint) === inputFingerprint &&
          (asNullableText(previous.outputFingerprint) || null) ===
            outputFingerprint &&
          asText(previous.errorFingerprint) === errorFingerprint;
      } catch {
        repeatedFingerprint = false;
      }
      const effectiveRetryable =
        options.retryable !== false && !repeatedFingerprint;
      const dead = !effectiveRetryable ||
        current.attempts >= current.maxAttempts;
      const nextAvailable = new Date(
        Date.parse(timestamp) + Math.max(0, retryDelayMs),
      ).toISOString();
      const compensationAction = repeatedFingerprint
        ? 'stop_repeated_fingerprint'
        : cleanText(options.compensationAction) || null;
      this.database
        .prepare(
          `UPDATE memory_jobs
           SET status = ?, available_at = ?, lease_until = NULL,
               lease_owner = NULL, last_error = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        )
        .run(
          dead ? 'dead' : 'failed',
          nextAvailable,
          message,
          timestamp,
          current.id,
          owner,
        );
      if (dead) {
        this.database
          .prepare(
            `INSERT INTO dead_letter_jobs (
               job_id, job_type, user_id, namespace, payload_json,
               attempts, last_error, failed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(job_id) DO UPDATE SET
               attempts = excluded.attempts,
               last_error = excluded.last_error,
               failed_at = excluded.failed_at`,
          )
          .run(
            current.id,
            current.jobType,
            current.userId,
            current.namespace,
            JSON.stringify(current.payload),
            current.attempts,
            message,
            timestamp,
          );
      }
      this.database
        .prepare(
          `INSERT INTO audit_log (
             id, action, memory_id, user_id, detail_json, created_at
           )
           SELECT COALESCE(MAX(id), 0) + 1,
                  'job_attempt_failed', NULL, ?, ?, ?
           FROM audit_log
           WHERE user_id = ?`,
        )
        .run(
          current.userId,
          JSON.stringify({
            jobId: current.id,
            jobType: current.jobType,
            namespace: current.namespace,
            attempt: current.attempts,
            maxAttempts: current.maxAttempts,
            failureClass,
            inputFingerprint,
            outputFingerprint,
            errorFingerprint,
            modelDurationMs: Number.isFinite(options.modelDurationMs)
              ? Math.max(0, Number(options.modelDurationMs))
              : null,
            missingSourceIds: options.missingSourceIds || [],
            compensationAction,
            recoveryStrategy:
              asNullableText(options.recoveryStrategy) || null,
            repeatedFingerprint,
            retryable: effectiveRetryable,
            nextState: dead ? 'dead' : 'failed',
            nextAvailable: dead ? null : nextAvailable,
          }),
          timestamp,
          current.userId,
        );
      this.database.exec('COMMIT');
      return this.getJob(current.id)!;
    } catch (caught) {
      this.database.exec('ROLLBACK');
      throw caught;
    }
  }

  getJob(jobId: string): MemoryJob | null {
    const row = this.database
      .prepare('SELECT * FROM memory_jobs WHERE id = ?')
      .get(cleanText(jobId)) as DatabaseRow | undefined;
    return row ? rowToJob(row) : null;
  }

  renewJobLease(
    jobId: string,
    workerId: string,
    leaseSeconds = 60,
  ): MemoryJob {
    const timestamp = this.now();
    const owner = cleanText(workerId);
    const leaseUntil = new Date(
      Date.parse(timestamp) + Math.max(1, leaseSeconds) * 1_000,
    ).toISOString();
    const result = this.database.prepare(
      `UPDATE memory_jobs
       SET lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?
         AND lease_until > ?`,
    ).run(
      leaseUntil,
      timestamp,
      cleanText(jobId),
      owner,
      timestamp,
    );
    if (Number(result.changes) !== 1) {
      throw new Error('只有持有有效租约的 Worker 可以续租任务');
    }
    return this.getJob(jobId)!;
  }

  assertJobLease(jobId: string, workerId: string): void {
    const row = this.database
      .prepare(
        `SELECT id
         FROM memory_jobs
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_until > ?`,
      )
      .get(
        cleanText(jobId),
        cleanText(workerId),
        this.now(),
      );
    if (!row) {
      throw new Error('任务租约已过期或不属于当前 Worker');
    }
  }

  startExtraction(
    turnId: string,
    model: string,
    promptVersion: string,
    extractorId = 'memory-extractor',
    extractorVersion = 'v1',
  ): string {
    const id = randomUUID();
    const timestamp = this.now();
    const promptContractVersion = cleanText(promptVersion);
    const promptRunKey = [
      promptContractVersion,
      sha256([
        cleanText(extractorId, 'memory-extractor'),
        cleanText(extractorVersion, 'v1'),
      ].join('\n')).slice(0, 16),
    ].join('#');
    this.database
      .prepare(
        `INSERT INTO extraction_runs (
           id, turn_id, model, prompt_version, extractor_id,
           extractor_version, prompt_contract_version, status,
           started_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
         ON CONFLICT(turn_id, model, prompt_version) DO NOTHING`,
      )
      .run(
        id,
        cleanText(turnId),
        cleanText(model),
        promptRunKey,
        cleanText(extractorId, 'memory-extractor'),
        cleanText(extractorVersion, 'v1'),
        promptContractVersion,
        timestamp,
        timestamp,
      );
    const row = this.database
      .prepare(
        `SELECT id
         FROM extraction_runs
         WHERE turn_id = ? AND model = ? AND prompt_version = ?`,
      )
      .get(
        cleanText(turnId),
        cleanText(model),
        promptRunKey,
      );
    if (!row) throw new Error('无法创建提取运行');
    const runId = asText(row.id);
    this.database
      .prepare(
        `UPDATE extraction_runs
         SET status = 'running', started_at = ?, completed_at = NULL,
             error = NULL, extractor_id = ?, extractor_version = ?,
             prompt_contract_version = ?
         WHERE id = ? AND status != 'completed'`,
      )
      .run(
        timestamp,
        cleanText(extractorId, 'memory-extractor'),
        cleanText(extractorVersion, 'v1'),
        promptContractVersion,
        runId,
      );
    return runId;
  }

  failExtraction(extractionRunId: string, error: string): void {
    const result = this.database
      .prepare(
        `UPDATE extraction_runs
         SET status = 'failed', completed_at = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        this.now(),
        cleanText(error, '未知错误'),
        cleanText(extractionRunId),
      );
    if (Number(result.changes) !== 1) {
      throw new Error('提取运行不存在');
    }
  }

  deferExtraction(extractionRunId: string, reason: string): void {
    const result = this.database
      .prepare(
        `UPDATE extraction_runs
         SET status = 'queued', completed_at = NULL, error = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        cleanText(reason, '后台提取已让权'),
        cleanText(extractionRunId),
      );
    if (Number(result.changes) !== 1) {
      throw new Error('只有运行中的提取任务可以归还');
    }
  }

  completeExtraction(
    extractionRunId: string,
    candidates: MemoryCandidateInput[],
    options: {
      enqueueResolution?: boolean;
      trustedCorrectionTargetId?: string;
    } = {},
  ): MemoryCandidate[] {
    const timestamp = this.now();
    const insertedIds: string[] = [];
    let run: DatabaseRow;

    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) {
      this.database.exec('BEGIN IMMEDIATE');
    }
    try {
      const selected = this.database
        .prepare(
           `SELECT r.*, t.user_id, t.namespace, t.role AS turn_role,
                  t.content AS turn_content,
                  t.metadata_json AS turn_metadata_json,
                  t.session_id AS trusted_session_id,
                  s.external_id AS session_external_id,
                  s.persona_id AS session_persona_id,
                  s.project_id AS session_project_id,
                  s.identity_status AS session_identity_status
           FROM extraction_runs r
           JOIN conversation_turns t ON t.id = r.turn_id
           JOIN conversation_sessions s ON s.id = t.session_id
           WHERE r.id = ?`,
        )
        .get(cleanText(extractionRunId)) as DatabaseRow | undefined;
      if (!selected) throw new Error('提取运行不存在');
      run = selected;
      const sessionIdentityStatus =
        asText(run.session_identity_status) || 'legacy';
      const trustedProjectId =
        sessionIdentityStatus === 'complete' &&
        isClientIdentityId(run.session_project_id)
          ? asText(run.session_project_id)
          : '';
      const trustedPersonaId = asText(run.session_persona_id);
      const trustedSessionId = asText(run.session_external_id);
      const turnContent = asText(run.turn_content);
      const turnMetadata = parseJson(run.turn_metadata_json);
      const trustedRoleAliases = new Set(
        [
          trustedPersonaId,
          turnMetadata.trustedPersonaDisplayName,
          ...(
            this.database
              .prepare(
                `SELECT display_name
                 FROM client_persona_bindings
                 WHERE principal_id = ?
                   AND persona_id = ?
                   AND status = 'active'`,
              )
              .all(asText(run.user_id), trustedPersonaId) as DatabaseRow[]
          ).map((row) => row.display_name),
        ]
          .map(normalizeRoleAlias)
          .filter(Boolean),
      );
      const trustedCorrectionTargetId = cleanText(
        options.trustedCorrectionTargetId,
      );
      if (trustedCorrectionTargetId && candidates.length !== 1) {
        throw new Error('精确纠正目标只能绑定一个候选');
      }
      let trustedCorrectionTarget: {
        kind: MemoryKind;
        scopeType: MemoryScopeType;
        scopeKey: string;
      } | null = null;
      if (trustedCorrectionTargetId) {
        const target = this.database
          .prepare(
            `SELECT
               i.user_id AS item_user_id,
               i.namespace AS item_namespace,
               i.kind AS item_kind,
               i.status AS item_status,
               i.scope_type AS item_scope_type,
               i.scope_key AS item_scope_key,
               m.user_id AS memory_user_id,
               m.namespace AS memory_namespace,
               m.kind AS memory_kind,
               m.status AS memory_status,
               m.scope_type AS memory_scope_type,
               m.scope_key AS memory_scope_key
             FROM memory_items i
             JOIN memories m ON m.id = i.id
             WHERE i.id = ?`,
          )
          .get(trustedCorrectionTargetId) as DatabaseRow | undefined;
        if (!target) throw new Error('可信纠正目标不存在');
        const itemScopeType = asText(
          target.item_scope_type,
        ) as MemoryScopeType;
        const memoryScopeType = asText(
          target.memory_scope_type,
        ) as MemoryScopeType;
        const itemScopeKey = asText(target.item_scope_key);
        const memoryScopeKey = asText(target.memory_scope_key);
        const itemKind = asText(target.item_kind) as MemoryKind;
        const memoryKind = asText(target.memory_kind) as MemoryKind;
        const sameOwner =
          asText(target.item_user_id) === asText(run.user_id) &&
          asText(target.memory_user_id) === asText(run.user_id) &&
          asText(target.item_namespace) === asText(run.namespace) &&
          asText(target.memory_namespace) === asText(run.namespace);
        const active =
          asText(target.item_status) === 'active' &&
          asText(target.memory_status) === 'active';
        const consistent =
          itemScopeType === memoryScopeType &&
          itemScopeKey === memoryScopeKey &&
          itemKind === memoryKind &&
          MEMORY_KINDS.includes(memoryKind);
        if (!sameOwner || !active || !consistent) {
          throw new Error('可信纠正目标状态或规范投影不一致');
        }
        const visible =
          (memoryScopeType === 'personal' &&
            memoryScopeKey === 'self') ||
          (sessionIdentityStatus === 'complete' &&
            ((memoryScopeType === 'role' &&
              memoryScopeKey === asText(run.session_persona_id)) ||
              (memoryScopeType === 'session' &&
                memoryScopeKey === asText(run.session_external_id)) ||
              (memoryScopeType === 'project' &&
                Boolean(trustedProjectId) &&
                memoryScopeKey === trustedProjectId)));
        if (!visible) {
          throw new Error('可信纠正目标对原会话不可见');
        }
        trustedCorrectionTarget = {
          kind: memoryKind,
          scopeType: memoryScopeType,
          scopeKey: memoryScopeKey,
        };
      }
      for (const candidate of candidates) {
        if (sessionIdentityStatus === 'degraded') {
          continue;
        }
        if (!MEMORY_KINDS.includes(candidate.kind)) {
          throw new Error('无效的候选记忆类型');
        }
        const subject = cleanText(candidate.subject);
        const predicate = cleanText(candidate.predicate);
        const value = cleanText(candidate.value);
        const rawContent = cleanText(candidate.content);
        const requestedExcerpt = evidenceText(
          candidate.sourceExcerpt,
        );
        const scopeEvidence = scopeEvidenceForCandidate(
          turnContent,
          requestedExcerpt,
        );
        const namedRoleScopes = namedRoleScopeNamesFromText(
          scopeEvidence,
        );
        if (!subject || !predicate || !value) {
          throw new Error('候选记忆字段不能为空');
        }
        const credentialCandidate = {
          predicate,
          value,
          content: rawContent,
          sourceExcerpt: evidenceText(candidate.sourceExcerpt),
          sensitivity: candidate.sensitivity,
        };
        const protectedSensitivity =
          protectedCredentialSensitivity(credentialCandidate);
        if (protectedSensitivity === 'credential') {
          continue;
        }
        const normalizedKey = stableCandidateKey(subject, predicate);
        const kind = trustedCorrectionTarget?.kind || candidate.kind;
        let scopeType = trustedCorrectionTarget?.scopeType ||
          (['personal', 'project', 'role', 'session'].includes(
            candidate.scopeType || '',
          )
            ? candidate.scopeType as MemoryScopeType
            : 'personal');
        if (kind === 'project' && !trustedCorrectionTarget) {
          scopeType = 'project';
        }
        if (
          !trustedCorrectionTarget &&
          EXPLICIT_PROJECT_SCOPE_PATTERN.test(scopeEvidence)
        ) {
          scopeType = 'project';
        }
        if (
          !trustedCorrectionTarget &&
          (
            EXPLICIT_ROLE_SCOPE_PATTERN.test(scopeEvidence) ||
            namedRoleScopes.length > 0
          )
        ) {
          scopeType = 'role';
        }
        if (
          !trustedCorrectionTarget &&
          kind !== 'project' &&
          !EXPLICIT_PROJECT_SCOPE_PATTERN.test(scopeEvidence) &&
          !EXPLICIT_ROLE_SCOPE_PATTERN.test(scopeEvidence) &&
          namedRoleScopes.length === 0 &&
          EXPLICIT_PERSONAL_SCOPE_PATTERN.test(scopeEvidence)
        ) {
          scopeType = 'personal';
        }
        let scopeKey = trustedCorrectionTarget?.scopeKey ||
          (scopeType === 'personal'
            ? 'self'
            : cleanText(candidate.scopeKey));
        let scopeIsolationReason: string | null = null;
        if (sessionIdentityStatus === 'complete') {
          if (!trustedPersonaId || !trustedSessionId) {
            throw new Error(
              '完整身份会话缺少可信 persona/session 绑定',
            );
          }
        }
        if (scopeType === 'project') {
          if (trustedProjectId) {
            scopeKey = trustedProjectId;
          } else {
            scopeKey = `unbound:${asText(run.trusted_session_id)}`;
            scopeIsolationReason = 'trusted_project_scope_required';
          }
        } else if (scopeType === 'role') {
          if (sessionIdentityStatus === 'complete') {
            const normalizedNamedRoles = new Set(
              namedRoleScopes.map(normalizeRoleAlias).filter(Boolean),
            );
            if (
              normalizedNamedRoles.size > 1 ||
              (
                normalizedNamedRoles.size === 1 &&
                !trustedRoleAliases.has(
                  [...normalizedNamedRoles][0],
                )
              )
            ) {
              scopeKey = `unbound:${asText(run.trusted_session_id)}`;
              scopeIsolationReason =
                'trusted_named_role_scope_required';
            } else {
              scopeKey = trustedPersonaId;
            }
          } else {
            scopeKey = `unbound:${asText(run.trusted_session_id)}`;
            scopeIsolationReason = 'trusted_role_scope_required';
          }
        } else if (scopeType === 'session') {
          if (!trustedSessionId) {
            throw new Error('会话候选缺少可信 session 绑定');
          }
          scopeKey = trustedSessionId;
        }
        if (!scopeKey) {
          scopeKey = `unbound:${asText(run.trusted_session_id)}`;
          scopeIsolationReason = 'trusted_scope_required';
        }
        const stableKey = scopedStableCandidateKey(
          normalizedKey,
          scopeType,
          scopeKey,
        );
        const negated = candidate.negated === true;
        const normalizedHash = sha256(
          `${stableKey}\n${negated ? 'negated' : 'affirmed'}\n` +
          normalizePart(value),
        );
        const sensitivity = protectedSensitivity;
        const claimOccurredAt = parseOptionalTimestamp(
          candidate.claimOccurredAt,
          'claimOccurredAt',
        );
        const claimValidFrom = parseOptionalTimestamp(
          candidate.claimValidFrom,
          'claimValidFrom',
        );
        const claimValidTo = parseOptionalTimestamp(
          candidate.claimValidTo,
          'claimValidTo',
        );
        if (
          claimValidFrom &&
          claimValidTo &&
          Date.parse(claimValidFrom) >= Date.parse(claimValidTo)
        ) {
          throw new Error('claimValidFrom 必须早于 claimValidTo');
        }
        const content = normalizeAtomicCandidateContent({
          subject,
          predicate,
          value,
          content: rawContent,
          sourceExcerpt: requestedExcerpt,
          negated,
        });
        const contentConstructed = content.length > 0;
        const state = scopeIsolationReason
          ? 'rejected'
          : contentConstructed
            ? candidate.state || 'pending'
            : 'pending';
        const decisionReason =
          scopeIsolationReason ||
          (!contentConstructed
            ? 'candidate_content_unconstructable'
            : negated && !candidate.decisionReason
              ? 'negation_requires_confirmation'
              : cleanText(candidate.decisionReason) || null);
        const sourceExcerpt =
          !containsCredentialSecret({
            predicate,
            value,
            content: rawContent,
            sourceExcerpt: requestedExcerpt,
          })
            ? alignSourceExcerpt(turnContent, {
              content: structuredAtomicCandidateText({
                subject,
                predicate,
                value,
                negated,
              }),
              value,
              sourceExcerpt: requestedExcerpt,
            })
            : '';
        const sourceAuthority =
          asText(run.turn_role) === 'user'
            ? 'direct_user'
            : 'assistant_inference';
        const explicitCorrection = CORRECTION_PATTERN.test(
          turnContent,
        );
        const id = randomUUID();
        const result = this.database
          .prepare(
            `INSERT INTO memory_candidates (
               id, user_id, namespace, turn_id, extraction_run_id, kind,
               subject, predicate, value_text, normalized_key,
               normalized_hash, stable_key, content, confidence, importance,
               sensitivity, state, decision_reason, explicit_correction,
               negated, scope_type, scope_key, claim_occurred_at,
               claim_valid_from, claim_valid_to, source_excerpt,
               source_authority, extractor_id, extractor_version,
               extraction_model, extraction_prompt_version,
               created_at, updated_at
             ) VALUES (
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             )
             ON CONFLICT(extraction_run_id, normalized_hash) DO NOTHING`,
          )
          .run(
            id,
            asText(run.user_id),
            asText(run.namespace),
            asText(run.turn_id),
            asText(run.id),
            kind,
            subject,
            predicate,
            value,
            normalizedKey,
            normalizedHash,
            stableKey,
            content,
            clamp(candidate.confidence),
            clamp(candidate.importance),
            sensitivity,
            state,
            decisionReason,
            explicitCorrection ? 1 : 0,
            negated ? 1 : 0,
            scopeType,
            scopeKey,
            claimOccurredAt,
            claimValidFrom,
            claimValidTo,
            sourceExcerpt || null,
            sourceAuthority,
            asText(run.extractor_id) || 'memory-extractor',
            asText(run.extractor_version) || 'v1',
            asText(run.model),
            asText(run.prompt_contract_version) ||
              asText(run.prompt_version),
            timestamp,
            timestamp,
          );
        if (Number(result.changes) === 1) {
          insertedIds.push(id);
          if (
            state === 'pending' &&
            options.enqueueResolution !== false
          ) {
            this.enqueueJobInternal({
              id: `resolve:${id}`,
              jobType: 'resolve_candidate',
              userId: asText(run.user_id),
              namespace: asText(run.namespace),
              payload: { candidateId: id },
              priority: 8,
              maxAttempts: 5,
              availableAt: timestamp,
            }, timestamp);
          }
        }
      }
      this.database
        .prepare(
          `UPDATE extraction_runs
           SET status = 'completed', completed_at = ?, error = NULL
           WHERE id = ?`,
        )
        .run(timestamp, asText(run.id));
      if (ownsTransaction) {
        this.database.exec('COMMIT');
      }
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }

    if (insertedIds.length === 0) {
      return this.listCandidates({
        extractionRunId: asText(run.id),
      });
    }
    return this.listCandidates({ ids: insertedIds });
  }

  getCandidate(
    candidateId: string,
    userId?: string,
    namespace?: string,
  ): MemoryCandidate | null {
    if ((userId === undefined) !== (namespace === undefined)) {
      throw new Error(
        'getCandidate 必须同时提供 userId 和 namespace',
      );
    }
    const row = this.database
      .prepare(
        `SELECT *
         FROM memory_candidates
         WHERE id = ?
           ${userId === undefined
             ? ''
             : 'AND user_id = ? AND namespace = ?'}`,
      )
      .get(
        cleanText(candidateId),
        ...(
          userId === undefined
            ? []
            : [cleanText(userId), cleanText(namespace)]
        ),
      ) as DatabaseRow | undefined;
    return row ? rowToCandidate(row) : null;
  }

  private assertReflectionCandidateReviewable(
    candidate: MemoryCandidate,
  ): void {
    const run = this.database.prepare(
      `SELECT status, cancel_requested_at, user_id, namespace,
              scope_type, scope_key
       FROM memory_reflection_runs
       WHERE id = ?`,
    ).get(candidate.reflectionRunId) as DatabaseRow | undefined;
    if (
      !run ||
      asText(run.status) !== 'completed' ||
      run.cancel_requested_at !== null ||
      asText(run.user_id) !== candidate.userId ||
      asText(run.namespace) !== candidate.namespace ||
      asText(run.scope_type) !== candidate.scopeType ||
      asText(run.scope_key) !== candidate.scopeKey
    ) {
      throw new Error('历史重提炼候选的运行状态或作用域已失效');
    }

    const evidenceRows = this.database.prepare(
      `SELECT
         e.excerpt, e.excerpt_hash,
         e.user_id AS evidence_user_id,
         e.namespace AS evidence_namespace,
         e.scope_type AS evidence_scope_type,
         e.scope_key AS evidence_scope_key,
         t.content AS turn_content,
         t.user_id AS turn_user_id,
         t.namespace AS turn_namespace,
         t.role AS turn_role,
         rt.content_hash AS run_turn_content_hash,
         s.persona_id,
         s.project_id,
         s.external_id AS session_external_id
       FROM memory_candidate_evidence e
       JOIN conversation_turns t ON t.id = e.turn_id
       JOIN conversation_sessions s ON s.id = t.session_id
       JOIN memory_reflection_run_turns rt
         ON rt.run_id = ? AND rt.turn_id = e.turn_id
       WHERE e.candidate_id = ?
       ORDER BY e.ordinal ASC, e.turn_id ASC`,
    ).all(candidate.reflectionRunId, candidate.id) as DatabaseRow[];
    if (evidenceRows.length === 0) {
      throw new Error('历史重提炼候选缺少可验证证据');
    }
    for (const evidence of evidenceRows) {
      const excerpt = asNullableText(evidence.excerpt);
      const turnContent = asText(evidence.turn_content);
      const scopeMatches = candidate.scopeType === 'personal'
        ? candidate.scopeKey === 'self'
        : candidate.scopeType === 'role'
          ? asText(evidence.persona_id) === candidate.scopeKey
          : candidate.scopeType === 'project'
            ? asText(evidence.project_id) === candidate.scopeKey
            : asText(evidence.session_external_id) === candidate.scopeKey;
      if (
        !excerpt ||
        turnContent === '[retention-redacted]' ||
        !turnContent.includes(excerpt) ||
        sha256(excerpt) !== asText(evidence.excerpt_hash) ||
        sha256(turnContent) !== asText(evidence.run_turn_content_hash) ||
        asText(evidence.evidence_user_id) !== candidate.userId ||
        asText(evidence.turn_user_id) !== candidate.userId ||
        asText(evidence.evidence_namespace) !== candidate.namespace ||
        asText(evidence.turn_namespace) !== candidate.namespace ||
        asText(evidence.evidence_scope_type) !== candidate.scopeType ||
        asText(evidence.evidence_scope_key) !== candidate.scopeKey ||
        asText(evidence.turn_role) !== 'user' ||
        !scopeMatches
      ) {
        throw new Error('历史重提炼候选的证据正文已被擦除或不可验证');
      }
    }
  }

  updateCandidateState(
    candidateId: string,
    state: CandidateState,
    decisionReason: string,
    resolvedMemoryItemId?: string,
    allowReviewOverride = false,
    resolution?: CandidateResolutionAudit,
    transactionalSideEffect?: (
      candidate: MemoryCandidate,
      timestamp: string,
    ) => void,
  ): MemoryCandidate {
    const timestamp = this.now();
    const finalState = state !== 'pending';
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) {
      this.database.exec('BEGIN IMMEDIATE');
    }
    try {
      const candidate = this.getCandidate(candidateId);
      if (!candidate) throw new Error('候选记忆不存在');
      if (
        candidate.state !== 'pending' &&
        candidate.state !== state &&
        !(
          allowReviewOverride &&
          candidate.state === 'conflicted' &&
          (state === 'accepted' || state === 'rejected')
        )
      ) {
        throw new Error('候选记忆已完成其他决策');
      }
      if (candidate.sensitivity === 'credential' && state === 'accepted') {
        throw new Error('凭据候选不能被接受');
      }
      if (state === 'accepted' && candidate.reflectionRunId) {
        this.assertReflectionCandidateReviewable(candidate);
      }
      const cleanReason = cleanText(decisionReason);
      const candidateUpdate = this.database
        .prepare(
          `UPDATE memory_candidates
           SET state = ?, decision_reason = ?,
               resolved_memory_item_id = COALESCE(
                 ?, resolved_memory_item_id
               ),
               resolved_at = CASE WHEN ? THEN ? ELSE NULL END,
               updated_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(
          state,
          cleanReason,
          resolvedMemoryItemId || null,
          finalState ? 1 : 0,
          timestamp,
          timestamp,
          candidate.id,
          candidate.state,
        );
      if (candidateUpdate.changes !== 1) {
        throw new Error('候选记忆已被其他审核操作更新');
      }
      const claimDecision = state === 'accepted'
        ? 'confirmed'
        : state === 'rejected'
          ? cleanReason === 'manual_rejected_and_tombstoned'
            ? 'blocked'
            : 'rejected'
          : null;
      if (claimDecision && candidate.claimFingerprint) {
        const claim = this.database
          .prepare(
            `SELECT decision
             FROM memory_reflection_claims
             WHERE candidate_id = ?
               AND user_id = ? AND namespace = ?
               AND scope_type = ? AND scope_key = ?
               AND claim_fingerprint = ?`,
          )
          .get(
            candidate.id,
            candidate.userId,
            candidate.namespace,
            candidate.scopeType,
            candidate.scopeKey,
            candidate.claimFingerprint,
          ) as DatabaseRow | undefined;
        if (!claim) {
          throw new Error('历史重提炼候选缺少 claim 注册记录');
        }
        const currentDecision = asText(claim.decision);
        if (
          currentDecision !== 'active' &&
          currentDecision !== claimDecision
        ) {
          throw new Error('候选记忆的 claim 已完成其他决策');
        }
        const claimUpdate = this.database
          .prepare(
            `UPDATE memory_reflection_claims
             SET decision = ?, updated_at = ?
             WHERE candidate_id = ?
               AND user_id = ? AND namespace = ?
               AND scope_type = ? AND scope_key = ?
               AND claim_fingerprint = ?
               AND decision IN ('active', ?)`,
          )
          .run(
            claimDecision,
            timestamp,
            candidate.id,
            candidate.userId,
            candidate.namespace,
            candidate.scopeType,
            candidate.scopeKey,
            candidate.claimFingerprint,
            claimDecision,
          );
        if (claimUpdate.changes !== 1) {
          throw new Error('候选记忆的 claim 已被其他审核操作更新');
        }
      }
      if (finalState) {
        this.database
          .prepare(
          `INSERT INTO outbox_events (
               id, aggregate_type, aggregate_id, event_type,
               payload_json, available_at, created_at, user_id, namespace
             ) VALUES (?, 'memory_candidate', ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(
               aggregate_type, aggregate_id, event_type
             ) DO NOTHING`,
          )
          .run(
            `candidate:${candidate.id}:${state}`,
            candidate.id,
            `candidate.${state}`,
            JSON.stringify({
              candidateId: candidate.id,
              state,
              decisionReason: cleanReason,
              resolvedMemoryItemId: resolvedMemoryItemId || null,
            }),
            timestamp,
            timestamp,
            candidate.userId,
            candidate.namespace,
          );
      }
      if (resolution) {
        const targetMemoryItemId =
          resolution.targetMemoryItemId ||
          resolvedMemoryItemId ||
          null;
        const resolutionId = `resolution:${sha256([
          candidate.id,
          targetMemoryItemId || 'none',
          resolution.relation,
          resolution.method,
        ].join('\n'))}`;
        this.database
          .prepare(
            `INSERT INTO candidate_resolution_runs (
               id, candidate_id, target_memory_item_id, relation,
               method, confidence, model, prompt_version, rationale,
               status, error, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .run(
            resolutionId,
            candidate.id,
            targetMemoryItemId,
            resolution.relation,
            resolution.method,
            clamp(resolution.confidence),
            cleanText(resolution.model) || null,
            cleanText(resolution.promptVersion) || null,
            cleanText(resolution.rationale),
            resolution.status || 'completed',
            cleanText(resolution.error) || null,
            timestamp,
          );
      }
      transactionalSideEffect?.(candidate, timestamp);
      if (ownsTransaction) {
        this.database.exec('COMMIT');
      }
      return this.getCandidate(candidate.id)!;
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  listCandidates(
    input: {
      userId?: string;
      namespace?: string;
      state?: CandidateState;
      extractionRunId?: string;
      reflectionRunId?: string;
      ids?: string[];
      limit?: number;
    } = {},
  ): MemoryCandidate[] {
    const where: string[] = [];
    const values: SQLInputValue[] = [];
    if (input.userId) {
      where.push('user_id = ?');
      values.push(cleanText(input.userId));
    }
    if (input.namespace) {
      where.push('namespace = ?');
      values.push(cleanText(input.namespace));
    }
    if (input.state) {
      where.push('state = ?');
      values.push(input.state);
    }
    if (input.extractionRunId) {
      where.push('extraction_run_id = ?');
      values.push(cleanText(input.extractionRunId));
    }
    if (input.reflectionRunId) {
      where.push('reflection_run_id = ?');
      values.push(cleanText(input.reflectionRunId));
    }
    if (input.ids?.length) {
      where.push(`id IN (${input.ids.map(() => '?').join(', ')})`);
      values.push(...input.ids);
    }
    const rows = this.database
      .prepare(
        `SELECT *
         FROM memory_candidates
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(...values, Math.max(1, Math.min(input.limit || 100, 500))) as
      DatabaseRow[];
    return rows.map(rowToCandidate);
  }

  private enqueueSessionConsolidationJobs(
    sessionId: string,
    trigger: 'ended' | 'idle',
    timestamp: string,
  ): number {
    const normalizedSessionId = cleanText(sessionId);
    const session = this.database
      .prepare(
        `SELECT id, user_id, namespace
         FROM conversation_sessions
         WHERE id = ?`,
      )
      .get(normalizedSessionId) as DatabaseRow | undefined;
    if (!session) return 0;
    const turnState = this.database
      .prepare(
        `SELECT
           COUNT(*) AS turn_count,
           MAX(created_at) AS last_turn_created_at
         FROM conversation_turns
         WHERE session_id = ?`,
      )
      .get(normalizedSessionId) as DatabaseRow | undefined;
    const turnCount = Number(turnState?.turn_count || 0);
    if (turnCount === 0) return 0;
    const lastTurn = this.database
      .prepare(
        `SELECT id
         FROM conversation_turns
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(normalizedSessionId) as DatabaseRow | undefined;
    const sourceRows = this.database
      .prepare(
        `SELECT DISTINCT
           i.scope_type,
           i.scope_key,
           v.id AS memory_version_id
         FROM memory_items i
         JOIN memories m ON m.id = i.id
         JOIN memory_versions v ON v.id = i.current_version_id
         JOIN memory_evidence e ON e.memory_version_id = v.id
         JOIN conversation_turns t ON t.id = e.turn_id
         WHERE t.session_id = ?
           AND i.user_id = ?
           AND i.namespace = ?
           AND i.status = 'active'
           AND m.status = 'active'
           AND m.source NOT IN (
             'conversation_episode',
             'hierarchical_summary',
             'consolidation'
           )
           AND m.scope_type = i.scope_type
           AND m.scope_key = i.scope_key
           AND v.scope_type = i.scope_type
           AND v.scope_key = i.scope_key
         ORDER BY i.scope_type ASC, i.scope_key ASC, v.id ASC`,
      )
      .all(
        normalizedSessionId,
        asText(session.user_id),
        asText(session.namespace),
      ) as DatabaseRow[];
    const groups = new Map<string, {
      accessScopeType: MemoryScopeType;
      accessScopeKey: string;
      versionIds: string[];
    }>();
    for (const row of sourceRows) {
      const rawScopeType = asText(row.scope_type) as MemoryScopeType;
      const accessScopeType = MEMORY_SCOPE_TYPES.includes(rawScopeType)
        ? rawScopeType
        : 'personal';
      const accessScopeKey = cleanText(
        asText(row.scope_key),
        'self',
      );
      const groupKey = JSON.stringify([
        accessScopeType,
        accessScopeKey,
      ]);
      const group = groups.get(groupKey) || {
        accessScopeType,
        accessScopeKey,
        versionIds: [],
      };
      group.versionIds.push(asText(row.memory_version_id));
      groups.set(groupKey, group);
    }

    let enqueued = 0;
    for (const group of groups.values()) {
      const watermark = sha256([
        normalizedSessionId,
        String(turnCount),
        asText(turnState?.last_turn_created_at),
        asText(lastTurn?.id),
        ...[...new Set(group.versionIds)].sort(),
      ].join('\u0000'));
      const jobId = `consolidate-session:${sha256([
        asText(session.user_id),
        asText(session.namespace),
        normalizedSessionId,
        group.accessScopeType,
        group.accessScopeKey,
        watermark,
      ].join('\u0000'))}`;
      const inserted = this.enqueueJobInternal({
        id: jobId,
        jobType: 'consolidate_scope',
        userId: asText(session.user_id),
        namespace: asText(session.namespace),
        payload: {
          userId: asText(session.user_id),
          namespace: asText(session.namespace),
          scopeType: 'session',
          scopeKey: normalizedSessionId,
          accessScopeType: group.accessScopeType,
          accessScopeKey: group.accessScopeKey,
          trigger,
          watermark,
        },
        priority: trigger === 'ended' ? 3 : 1,
        maxAttempts: 5,
        availableAt: timestamp,
      }, timestamp);
      if (inserted) enqueued += 1;
    }
    return enqueued;
  }

  private enqueueSessionSummaryJobs(
    sessionId: string,
    trigger: 'ended' | 'idle' | 'episode_materialized',
    timestamp: string,
  ): number {
    const normalizedSessionId = cleanText(sessionId);
    const session = this.database.prepare(
      `SELECT id, user_id, namespace FROM conversation_sessions
       WHERE id = ?`,
    ).get(normalizedSessionId) as DatabaseRow | undefined;
    if (!session) return 0;
    const rows = this.database.prepare(
      `SELECT e.scope_type, e.scope_key, e.occurred_at,
              i.current_version_id AS memory_version_id
       FROM conversation_episodes e
       JOIN memories m ON m.id = e.memory_id
       JOIN memory_items i ON i.id = e.memory_id
       WHERE e.session_id = ?
         AND e.user_id = ? AND e.namespace = ?
         AND e.status = 'active'
         AND m.status = 'active' AND i.status = 'active'
         AND m.source = 'conversation_episode'
       ORDER BY e.scope_type, e.scope_key, e.occurred_at,
                e.id`,
    ).all(
      normalizedSessionId,
      asText(session.user_id),
      asText(session.namespace),
    ) as DatabaseRow[];
    if (rows.length === 0) return 0;
    const timezoneOffsetMinutes = config.summaryTimezoneOffsetMinutes;
    const groups = new Map<string, {
      summaryType: 'session' | 'day' | 'week';
      bucketKey: string;
      scopeType: MemoryScopeType;
      scopeKey: string;
      versionIds: string[];
    }>();
    for (const row of rows) {
      const scopeType = asText(row.scope_type) as MemoryScopeType;
      const scopeKey = cleanText(asText(row.scope_key));
      if (!MEMORY_SCOPE_TYPES.includes(scopeType) || !scopeKey) continue;
      const buckets = summaryBucketKeys(
        asText(row.occurred_at),
        timezoneOffsetMinutes,
      );
      for (const [summaryType, bucketKey] of [
        ['session', normalizedSessionId],
        ['day', buckets.day],
        ['week', buckets.week],
      ] as const) {
        const key = JSON.stringify([
          summaryType,
          bucketKey,
          scopeType,
          scopeKey,
        ]);
        const group = groups.get(key) || {
          summaryType,
          bucketKey,
          scopeType,
          scopeKey,
          versionIds: [],
        };
        group.versionIds.push(asText(row.memory_version_id));
        groups.set(key, group);
      }
    }
    let enqueued = 0;
    for (const group of groups.values()) {
      const watermark = sha256(
        [...new Set(group.versionIds)].sort().join('\u0000'),
      );
      const identity = [
        asText(session.user_id),
        asText(session.namespace),
        group.summaryType,
        group.bucketKey,
        group.scopeType,
        group.scopeKey,
        String(timezoneOffsetMinutes),
        watermark,
      ].join('\u0000');
      const inserted = this.enqueueJobInternal({
        id: `summarize-memory-bucket:${sha256(identity)}`,
        jobType: 'summarize_memory_bucket',
        userId: asText(session.user_id),
        namespace: asText(session.namespace),
        payload: {
          userId: asText(session.user_id),
          namespace: asText(session.namespace),
          summaryType: group.summaryType,
          bucketKey: group.bucketKey,
          scopeType: group.scopeType,
          scopeKey: group.scopeKey,
          timezoneOffsetMinutes,
          trigger,
          watermark,
        },
        priority: trigger === 'ended' ? 3 : 1,
        maxAttempts: 5,
        availableAt: timestamp,
      }, timestamp);
      if (inserted) enqueued += 1;
    }
    return enqueued;
  }

  private enqueueJobInternal(
    input: EnqueueJobInput,
    timestamp: string,
  ): boolean {
    const jobType = cleanText(input.jobType);
    if (!jobType) throw new Error('jobType 不能为空');
    const id = input.id || this.jobId(input);
    const maxAttempts = Math.max(
      1,
      Math.min(input.maxAttempts || 5, 100),
    );
    const availableAt = parseTimestamp(
      input.availableAt,
      timestamp,
      'availableAt',
    );
    const requiredModelId =
      cleanText(input.requiredModelId) || null;
    const requiredGenerationId =
      cleanText(input.requiredGenerationId) || null;
    if (requiredGenerationId) {
      const generation = this.database
        .prepare(
          `SELECT model_id
           FROM dense_index_generations
           WHERE generation_id = ?`,
        )
        .get(requiredGenerationId);
      if (!generation) {
        throw new Error('任务要求的 Dense generation 不存在');
      }
      if (
        requiredModelId &&
        asText(generation.model_id) !== requiredModelId
      ) {
        throw new Error('任务要求的 model/generation 不匹配');
      }
    }
    const inserted = this.database
      .prepare(
        `INSERT INTO memory_jobs (
           id, job_type, user_id, namespace, payload_json, priority,
           max_attempts, available_at, created_at, updated_at,
           required_model_id, required_generation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        jobType,
        cleanText(input.userId, config.defaultUserId),
        cleanText(input.namespace, config.defaultNamespace),
        JSON.stringify(input.payload || {}),
        Math.trunc(input.priority || 0),
        maxAttempts,
        availableAt,
        timestamp,
        timestamp,
        requiredModelId,
        requiredGenerationId,
      );
    return Number(inserted.changes) === 1;
  }

  private enqueueOutboxJob(event: OutboxEvent): void {
    const timestamp = this.now();
    const ownerId = cleanText(event.userId);
    const namespace = cleanText(event.namespace);
    if (!ownerId || !namespace) {
      throw new Error(
        'outbox 缺少可信 principal 或 namespace 边界',
      );
    }
    if (event.aggregateType === 'turn') {
      for (const key of ['turnId', 'userTurnId'] as const) {
        const referenced = event.payload[key];
        if (
          referenced !== undefined &&
          (
            typeof referenced !== 'string' ||
            referenced !== event.aggregateId
          )
        ) {
          throw new Error(
            'outbox payload turn 与 principal 聚合边界不一致',
          );
        }
      }
      const turn = this.getTurn(
        event.aggregateId,
        ownerId,
        namespace,
      );
      if (!turn || turn.role !== 'user') {
        throw new Error(
          'outbox principal 作用域内的用户 turn 不存在',
        );
      }
      const assistantTurnId =
        typeof event.payload.assistantTurnId === 'string'
          ? event.payload.assistantTurnId
          : undefined;
      if (assistantTurnId) {
        const assistantTurn = this.getTurn(
          assistantTurnId,
          ownerId,
          namespace,
        );
        if (
          !assistantTurn ||
          assistantTurn.role !== 'assistant' ||
          assistantTurn.sessionId !== turn.sessionId
        ) {
          throw new Error(
            'outbox assistant turn 与 principal 或会话边界不一致',
          );
        }
      }
      const trustedSession = this.database
        .prepare(
          `SELECT external_id, persona_id, project_id, identity_status
           FROM conversation_sessions
           WHERE id = ? AND user_id = ? AND namespace = ?`,
        )
        .get(turn.sessionId, ownerId, namespace) as
          | DatabaseRow
          | undefined;
      if (!trustedSession) {
        throw new Error('outbox turn 缺少可信会话身份');
      }
      if (event.eventType === 'turn.completed' && assistantTurnId) {
        this.enqueueJobInternal({
          id: `materialize-episode:${turn.id}:${assistantTurnId}`,
          jobType: 'materialize_episode',
          userId: ownerId,
          namespace,
          payload: {
            userTurnId: turn.id,
            assistantTurnId,
            sessionId: turn.sessionId,
          },
          priority: 20,
          maxAttempts: 5,
          availableAt: timestamp,
        }, timestamp);
      }
      this.enqueueJobInternal({
        id: `extract:${turn.id}`,
        jobType: 'extract_turn',
        userId: ownerId,
        namespace,
        payload: {
          principalId: ownerId,
          turnId: turn.id,
          sessionId: turn.sessionId,
          sessionExternalId: asText(trustedSession.external_id),
          personaId: asNullableText(trustedSession.persona_id),
          projectId: asNullableText(trustedSession.project_id),
          identityStatus: asText(trustedSession.identity_status),
          ...(assistantTurnId ? { assistantTurnId } : {}),
        },
        priority: 10,
        maxAttempts: 5,
        availableAt: timestamp,
      }, timestamp);
      return;
    }
    if (event.aggregateType === 'memory_event') {
      const memoryEvent = this.database
        .prepare(
          `SELECT e.memory_item_id
           FROM memory_events e
           JOIN memory_items i ON i.id = e.memory_item_id
           WHERE e.id = ?
             AND e.user_id = ?
             AND i.user_id = ?
             AND i.namespace = ?`,
        )
        .get(
          event.aggregateId,
          ownerId,
          ownerId,
          namespace,
        ) as DatabaseRow | undefined;
      if (!memoryEvent) {
        throw new Error(
          'outbox principal 作用域内的 memory event 不存在',
        );
      }
      const memoryId =
        typeof event.payload.memoryId === 'string'
          ? event.payload.memoryId
          : '';
      if (!memoryId) {
        throw new Error('memory_event outbox 缺少 memoryId');
      }
      if (memoryId !== asText(memoryEvent.memory_item_id)) {
        throw new Error(
          'memory_event outbox payload 与 principal 聚合边界不一致',
        );
      }
      const memory = this.database
        .prepare(
          `SELECT user_id, namespace, status, source,
                  valid_from, updated_at
           FROM memories
           WHERE id = ? AND user_id = ? AND namespace = ?`,
        )
        .get(
          memoryId,
          ownerId,
          namespace,
        ) as DatabaseRow | undefined;
      if (!memory) {
        throw new Error(
          'memory_event outbox principal 作用域内的记忆不存在',
        );
      }
      const denseTargets = this.database
        .prepare(
          `SELECT DISTINCT g.generation_id, g.model_id
           FROM dense_index_aliases a
           JOIN dense_index_generations g
             ON g.generation_id IN (
               a.active_generation_id,
               a.building_generation_id,
               a.previous_generation_id
             )
           WHERE a.user_id = ? AND a.namespace = ?
           ORDER BY g.generation_id ASC`,
        )
        .all(ownerId, namespace) as DatabaseRow[];
      const targets = denseTargets.length > 0
        ? denseTargets.map((row) => ({
            generationId: asText(row.generation_id),
            modelId: asText(row.model_id),
          }))
        : [{ generationId: '', modelId: '' }];
      for (const target of targets) {
        this.enqueueJobInternal({
          id: [
            'index-memory',
            event.aggregateId,
            target.generationId || 'unbound',
          ].join(':'),
          jobType: 'index_memory',
          userId: ownerId,
          namespace,
          payload: {
            memoryId,
            eventId: event.aggregateId,
            ...(target.generationId
              ? { generationId: target.generationId }
              : {}),
          },
          requiredModelId: target.modelId || undefined,
          requiredGenerationId:
            target.generationId || undefined,
          priority: 8,
          maxAttempts: 5,
          availableAt: timestamp,
        }, timestamp);
      }
      const validFrom = asNullableText(memory.valid_from);
      if (
        asText(memory.status) === 'active' &&
        validFrom &&
        Date.parse(validFrom) > Date.parse(timestamp)
      ) {
        for (const target of targets) {
          this.enqueueJobInternal({
            id: [
              'index-memory-valid-from',
              memoryId,
              asText(memory.updated_at),
              target.generationId || 'unbound',
            ].join(':'),
            jobType: 'index_memory',
            userId: ownerId,
            namespace,
            payload: {
              memoryId,
              eventId: event.aggregateId,
              scheduledFor: validFrom,
              ...(target.generationId
                ? { generationId: target.generationId }
                : {}),
            },
            requiredModelId: target.modelId || undefined,
            requiredGenerationId:
              target.generationId || undefined,
            priority: 8,
            maxAttempts: 5,
            availableAt: validFrom,
          }, timestamp);
        }
      }
      if (
        ![
          'conversation_episode',
          'hierarchical_summary',
          'consolidation',
        ].includes(asText(memory.source))
      ) {
        this.enqueueJobInternal({
          id: `consolidate-change:${event.aggregateId}`,
          jobType: 'consolidate_memory_change',
          userId: asText(memory.user_id),
          namespace: asText(memory.namespace),
          payload: {
            memoryId,
            eventId: event.aggregateId,
          },
          priority: 4,
          maxAttempts: 5,
          availableAt: timestamp,
        }, timestamp);
      }
      return;
    }
    if (event.aggregateType === 'memory_candidate') {
      const candidate = this.database
        .prepare(
          `SELECT id
           FROM memory_candidates
           WHERE id = ? AND user_id = ? AND namespace = ?`,
        )
        .get(
          event.aggregateId,
          ownerId,
          namespace,
        ) as DatabaseRow | undefined;
      if (!candidate) {
        throw new Error(
          'outbox principal 作用域内的候选记忆不存在',
        );
      }
      const payloadCandidateId =
        typeof event.payload.candidateId === 'string'
          ? event.payload.candidateId
          : event.aggregateId;
      if (payloadCandidateId !== event.aggregateId) {
        throw new Error(
          'candidate outbox payload 与 principal 聚合边界不一致',
        );
      }
      const resolvedMemoryItemId =
        typeof event.payload.resolvedMemoryItemId === 'string'
          ? event.payload.resolvedMemoryItemId
          : '';
      if (resolvedMemoryItemId) {
        const resolved = this.database
          .prepare(
            `SELECT id
             FROM memory_items
             WHERE id = ? AND user_id = ? AND namespace = ?`,
          )
          .get(
            resolvedMemoryItemId,
            ownerId,
            namespace,
          );
        if (!resolved) {
          throw new Error(
            'candidate outbox 解析目标超出 principal 作用域',
          );
        }
      }
      return;
    }
    throw new Error(`不支持的 outbox aggregate：${event.aggregateType}`);
  }

  private jobId(input: EnqueueJobInput): string {
    return `job:${sha256(JSON.stringify({
      jobType: cleanText(input.jobType),
      userId: cleanText(input.userId, config.defaultUserId),
      namespace: cleanText(input.namespace, config.defaultNamespace),
      payload: input.payload || {},
      requiredModelId: cleanText(input.requiredModelId),
      requiredGenerationId: cleanText(
        input.requiredGenerationId,
      ),
    }))}`;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
