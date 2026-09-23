import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  config,
  SYSTEM_JOB_NAMESPACE,
  SYSTEM_JOB_USER_ID,
} from './config.js';
import {
  CandidateResolver,
  type CandidateReviewInput,
  type CandidateResolutionResult,
} from './candidate-resolver.js';
import {
  consolidationSweepSuccessorId,
  deadLetterRecoveryJobId,
  isCanonicalConsolidationSweepJobId,
  LifecycleStore,
  type DeadLetterRecoveryMode,
  type MemoryJob,
} from './lifecycle-store.js';
import type {
  ClaimRelationAssessment,
  ClaimSubject,
} from './claim-relation-engine.js';
import {
  MemoryGovernance,
  type MemoryGovernanceRecord,
} from './memory-governance.js';
import { namedRoleScopeNamesFromText } from './memory-extractor.js';
import {
  modelRuntimeStatus,
  type ModelRuntimeStatus,
} from './model-qos.js';
import {
  MemoryStore,
  type RestoreDecisionResult,
  type RestoreMemoryInput,
} from './memory-store.js';
import type {
  MemoryAccessScope,
  PredicateCardinality,
} from './types.js';

type DatabaseRow = Record<string, unknown>;

function cleanText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim();
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = cleanText(value);
  return text || null;
}

function evidenceNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    )
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export interface CandidateInboxItem {
  id: string;
  userId: string;
  namespace: string;
  scopeType: string;
  scopeKey: string;
  kind: string;
  subject: string;
  predicate: string;
  value: string;
  negated: boolean;
  content: string;
  confidence: number;
  importance: number;
  sensitivity: string;
  sourceAuthority: string;
  sourceExcerpt: string | null;
  claimOccurredAt: string | null;
  claimValidFrom: string | null;
  claimValidTo: string | null;
  state: string;
  decisionReason: string | null;
  explicitCorrection: boolean;
  resolvedMemoryItemId: string | null;
  turnId: string | null;
  turnContent: string | null;
  extractionModel: string | null;
  promptVersion: string | null;
  reflectionRunId: string | null;
  candidateOrigin: string;
  claimFingerprint: string | null;
  evidenceCount: number;
  evidenceSessionCount: number;
  evidenceStartedAt: string | null;
  evidenceEndedAt: string | null;
  evidence: Array<{
    turnId: string;
    excerpt: string | null;
    evidenceType: string;
    occurredAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryActionRequestInboxItem {
  id: string;
  userId: string;
  namespace: string;
  action: 'remember' | 'correct' | 'forget';
  status: 'pending' | 'failed';
  targetQuery: string;
  targetMemoryId: string | null;
  candidateId: string | null;
  candidate: Record<string, unknown> | null;
  turnId: string | null;
  turnContent: string | null;
  confidence: number;
  sensitivity: string;
  model: string;
  promptVersion: string;
  rationale: string;
  error: string | null;
  reviewInProgress: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MemoryActionReviewInput {
  memoryId?: string;
  content?: string;
  value?: string;
}

export interface MemoryActionReviewResult {
  requestId: string;
  action: 'remember' | 'correct' | 'forget';
  status: 'completed' | 'rejected';
  memoryId: string | null;
  candidateId: string | null;
  reason: string;
}

export interface SystemHealthSnapshot {
  quality: 'full' | 'degraded' | 'unavailable';
  ollamaAvailable: boolean;
  availableModels: string[];
  missingModels: string[];
  modelRuntime: ModelRuntimeStatus & { keepAlive: string };
  queues: Array<{
    jobType: string;
    status: string;
    count: number;
    oldestAvailableAt: string | null;
  }>;
  deadLetterCount: number;
  deadLetterHistoryCount: number;
  deadLetters: Array<{
    jobId: string;
    jobType: string;
    namespace: string;
    attempts: number;
    lastError: string;
    failedAt: string;
    resolved: boolean;
    recoveryJobId: string | null;
    recoveryStatus: string | null;
    recoveryMode: DeadLetterRecoveryMode | 'system_takeover' | null;
  }>;
  jobAttempts: Array<{
    jobId: string;
    jobType: string;
    namespace: string;
    outcome: 'completed' | 'failed';
    attempt: number;
    maxAttempts: number;
    failureClass: string | null;
    resultStatus: string | null;
    compensationAction: string | null;
    recoveryStrategy: string | null;
    noopReason: string | null;
    retryable: boolean | null;
    repeatedFingerprint: boolean | null;
    nextState: string;
    modelDurationMs: number | null;
    inputFingerprint: string | null;
    outputFingerprint: string | null;
    errorFingerprint: string | null;
    missingSourceIds: string[];
    createdAt: string;
  }>;
  candidateCounts: Record<string, number>;
  index: {
    activeMemories: number;
    ftsMemories: number;
    annMemories: number;
    termMemories: number;
    embeddingMemories: number;
    denseEligible: number;
    denseIndexed: number;
    denseDimensions: number | null;
    denseIndexVersion: string;
    lag: number;
  };
  denseIndex: {
    alias: {
      activeGenerationId: string | null;
      buildingGenerationId: string | null;
      previousGenerationId: string | null;
      revision: number;
      updatedAt: string;
    } | null;
    generations: Array<{
      role: 'active' | 'building' | 'previous';
      generationId: string;
      modelId: string;
      embeddingModel: string;
      indexVersion: string;
      dimensions: number;
      generationKey: string;
      status: string;
      readyAt: string | null;
      failureReason: string | null;
      evaluation: {
        evaluationId: string;
        datasetId: string;
        datasetSha256: string;
        evaluatorVersion: string;
        queryCount: number;
        recallAt20: number;
        mrrAt10: number;
        passed: boolean;
        completedAt: string;
      } | null;
    }>;
  };
  automation: {
    averageExtractionLatencyMs: number | null;
    failedExtractionCount: number;
    retryingJobCount: number;
    staleConsolidationCount: number;
    quarantinedConsolidationCount: number;
  };
  retrievalLog: {
    logMode: 'metadata' | 'diagnostic';
    jsonlEnabled: boolean;
    jsonlPath: string;
    retentionDays: number;
    maxBytes: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    consecutiveFailures: number;
    totalFailures: number;
    lastError: string | null;
  };
  models: {
    chat: string;
    query: string;
    extraction: string;
    relation: string;
    explicitIntent: string;
    consolidation: string;
    reflection: string;
    embedding: string;
    reranker: string;
  };
  timestamp: string;
}

export interface MemoryDoctorIssue {
  category:
    | 'duplicate_stable_key'
    | 'active_single_value_conflict'
    | 'unresolved_candidate'
    | 'orphan_current_version'
    | 'orphan_edge'
    | 'stale_consolidation'
    | 'quarantined_consolidation'
    | 'role_constraint_in_personal_scope'
    | 'mixed_role_consolidation'
    | 'oversized_memory'
    | 'zero_result_hotspot'
    | 'reflection_orphan_run_turn'
    | 'reflection_orphan_candidate_evidence'
    | 'reflection_scope_mismatch'
    | 'reflection_checkpoint_ahead'
    | 'reflection_stuck_run'
    | 'reflection_reserved_model_call'
    | 'reflection_duplicate_claim'
    | 'reflection_invalid_content_hash'
    | 'episode_dense_unindexed'
    | 'summary_source_incomplete'
    | 'pattern_observation_scope_mismatch'
    | 'layered_job_backlog'
    | 'layered_job_failed'
    | 'layered_job_dead';
  severity: 'info' | 'warning' | 'critical';
  count: number;
  sampleIds: string[];
  recommendation: string;
}

export interface MemoryDoctorReport {
  userId: string;
  status: 'healthy' | 'needs_attention';
  issues: MemoryDoctorIssue[];
  generatedAt: string;
  destructiveActionsTaken: 0;
}

export class MemoryAdminUnavailableError extends Error {
  override readonly name = 'MemoryAdminUnavailableError';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class MemoryAdminService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly memoryStore: MemoryStore,
    private readonly lifecycleStore: LifecycleStore,
    private readonly candidateResolver: CandidateResolver,
    private readonly governance: MemoryGovernance,
  ) {}

  listCandidateInbox(
    limit = 200,
    userId = config.defaultUserId,
  ): CandidateInboxItem[] {
    const rows = this.database
      .prepare(
        `SELECT
           c.*,
           t.content AS turn_content,
           COALESCE(r.model, rr.model) AS extraction_model,
           COALESCE(r.prompt_version, rr.prompt_version) AS prompt_version,
           (
             SELECT COUNT(*)
             FROM memory_candidate_evidence ce
             WHERE ce.candidate_id = c.id
           ) AS evidence_count,
           (
             SELECT COUNT(DISTINCT et.session_id)
             FROM memory_candidate_evidence ce
             JOIN conversation_turns et ON et.id = ce.turn_id
             WHERE ce.candidate_id = c.id
           ) AS evidence_session_count,
           (
             SELECT MIN(et.occurred_at)
             FROM memory_candidate_evidence ce
             JOIN conversation_turns et ON et.id = ce.turn_id
             WHERE ce.candidate_id = c.id
           ) AS evidence_started_at,
           (
             SELECT MAX(et.occurred_at)
             FROM memory_candidate_evidence ce
             JOIN conversation_turns et ON et.id = ce.turn_id
             WHERE ce.candidate_id = c.id
           ) AS evidence_ended_at
         FROM memory_candidates c
         LEFT JOIN conversation_turns t ON t.id = c.turn_id
         LEFT JOIN extraction_runs r ON r.id = c.extraction_run_id
         LEFT JOIN memory_reflection_runs rr ON rr.id = c.reflection_run_id
         WHERE c.user_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM memory_action_requests a
             WHERE a.candidate_id = c.id
               AND a.status IN ('pending', 'failed')
           )
           AND (
             c.state IN ('pending', 'conflicted')
             OR (
               c.sensitivity != 'normal'
               AND c.state != 'accepted'
             )
           )
         ORDER BY
           CASE c.state
             WHEN 'conflicted' THEN 0
             WHEN 'pending' THEN 1
             ELSE 2
           END,
           c.created_at DESC
         LIMIT ?`,
      )
      .all(
        cleanText(userId),
        Math.max(1, Math.min(limit, 500)),
      ) as DatabaseRow[];
    const evidenceForCandidate = this.database.prepare(
      `SELECT e.turn_id, e.excerpt, e.evidence_type, t.occurred_at
       FROM memory_candidate_evidence e
       JOIN conversation_turns t ON t.id = e.turn_id
       WHERE e.candidate_id = ?
       ORDER BY e.ordinal ASC, e.turn_id ASC
       LIMIT 5`,
    );
    return rows.map((row) => ({
      id: cleanText(row.id),
      userId: cleanText(row.user_id),
      namespace: cleanText(row.namespace),
      scopeType: cleanText(row.scope_type),
      scopeKey: cleanText(row.scope_key),
      kind: cleanText(row.kind),
      subject: cleanText(row.subject),
      predicate: cleanText(row.predicate),
      value: cleanText(row.value_text),
      negated: Number(row.negated) === 1,
      content: cleanText(row.content),
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      sensitivity: cleanText(row.sensitivity),
      sourceAuthority: cleanText(row.source_authority),
      sourceExcerpt: evidenceNullableText(row.source_excerpt),
      claimOccurredAt: nullableText(row.claim_occurred_at),
      claimValidFrom: nullableText(row.claim_valid_from),
      claimValidTo: nullableText(row.claim_valid_to),
      state: cleanText(row.state),
      decisionReason: nullableText(row.decision_reason),
      explicitCorrection: Number(row.explicit_correction) === 1,
      resolvedMemoryItemId: nullableText(
        row.resolved_memory_item_id,
      ),
      turnId: nullableText(row.turn_id),
      turnContent: evidenceNullableText(row.turn_content),
      extractionModel: nullableText(row.extraction_model),
      promptVersion: nullableText(row.prompt_version),
      reflectionRunId: nullableText(row.reflection_run_id),
      candidateOrigin: cleanText(row.candidate_origin) ||
        'turn_extraction',
      claimFingerprint: nullableText(row.claim_fingerprint),
      evidenceCount: Number(row.evidence_count || 0),
      evidenceSessionCount: Number(row.evidence_session_count || 0),
      evidenceStartedAt: nullableText(row.evidence_started_at),
      evidenceEndedAt: nullableText(row.evidence_ended_at),
      evidence: (
        evidenceForCandidate.all(cleanText(row.id)) as DatabaseRow[]
      ).map((evidence) => ({
        turnId: cleanText(evidence.turn_id),
        excerpt: evidenceNullableText(evidence.excerpt),
        evidenceType: cleanText(evidence.evidence_type),
        occurredAt: cleanText(evidence.occurred_at),
      })),
      createdAt: cleanText(row.created_at),
      updatedAt: cleanText(row.updated_at),
    }));
  }

  acceptCandidate(
    candidateId: string,
    input: CandidateReviewInput = {},
    userId = config.defaultUserId,
  ): CandidateResolutionResult {
    this.assertCandidateOwned(candidateId, userId);
    const linkedCorrection = this.database
      .prepare(
        `SELECT 1
         FROM memory_action_requests
         WHERE candidate_id = ?
           AND user_id = ?
           AND action = 'correct'
           AND status IN ('pending', 'failed')
         LIMIT 1`,
      )
      .get(cleanText(candidateId), cleanText(userId));
    if (linkedCorrection) {
      throw new Error('纠正动作候选必须使用专用审核入口');
    }
    return this.candidateResolver.acceptForReview(
      candidateId,
      input,
    );
  }

  rejectCandidate(
    candidateId: string,
    blockFuture = false,
    userId = config.defaultUserId,
  ): CandidateResolutionResult {
    this.assertCandidateOwned(candidateId, userId);
    return this.candidateResolver.rejectForReview(
      candidateId,
      blockFuture,
    );
  }

  listMemoryActionInbox(
    limit = 200,
    userId = config.defaultUserId,
  ): MemoryActionRequestInboxItem[] {
    const rows = this.database
      .prepare(
        `SELECT a.*, t.content AS turn_content
         FROM memory_action_requests a
         LEFT JOIN conversation_turns t ON t.id = a.turn_id
         WHERE a.user_id = ?
           AND a.status IN ('pending', 'failed')
         ORDER BY
           CASE a.status WHEN 'pending' THEN 0 ELSE 1 END,
           a.created_at DESC
         LIMIT ?`,
      )
      .all(
        cleanText(userId),
        Math.max(1, Math.min(limit, 500)),
      ) as DatabaseRow[];
    return rows.map((row) => this.actionInboxItem(row));
  }

  acceptMemoryActionRequest(
    requestId: string,
    input: MemoryActionReviewInput = {},
    userId = config.defaultUserId,
  ): MemoryActionReviewResult {
    const ownerId = cleanText(userId);
    const existing = this.actionRequestRow(requestId, ownerId);
    if (cleanText(existing.status) === 'completed') {
      return this.actionReviewResult(
        existing,
        'manual_action_already_completed',
      );
    }
    if (cleanText(existing.status) === 'rejected') {
      throw new Error('记忆动作请求已经被拒绝');
    }
    const claimed = this.claimActionRequest(requestId, ownerId);
    const token = cleanText(claimed.review_token);
    try {
      const action = cleanText(
        claimed.action,
      ) as MemoryActionReviewResult['action'];
      let memoryId: string | null = null;
      let candidateId = nullableText(claimed.candidate_id);
      let reason: string;
      if (action === 'forget') {
        const targetId = cleanText(input.memoryId);
        if (!targetId) {
          throw new Error('确认忘记时必须选择目标记忆');
        }
        const memory = this.memoryStore.get(
          targetId,
          true,
          ownerId,
        );
        if (!memory) throw new Error('记忆不存在');
        if (
          memory.namespace !== cleanText(claimed.namespace)
        ) {
          throw new Error('所选目标记忆不存在于该请求的命名空间');
        }
        if (
          memory.status !== 'active' &&
          memory.status !== 'archived'
        ) {
          throw new Error('只能忘记当前有效或已归档的目标记忆');
        }
        const authorizedScopes = this.actionRequestScopes(
          claimed,
          ownerId,
        );
        if (!authorizedScopes.some(
          (scope) =>
            scope.scopeType === memory.scopeType &&
            scope.scopeKey === memory.scopeKey,
        )) {
          throw new Error('遗忘目标对原会话不可见');
        }
        reason = 'manual_forget_confirmed';
        const forgotten = this.memoryStore.forget(
          memory.id,
          '用户在待确认收件箱中确认遗忘',
          ownerId,
          {
            expectedNamespace: cleanText(claimed.namespace),
            authorizedScopes,
            beforeCommit: (deleted) => {
              this.finishActionReview(
                requestId,
                token,
                'completed',
                deleted.id,
                candidateId,
                reason,
                ownerId,
                cleanText(claimed.namespace),
                action,
              );
            },
          },
        );
        return {
          requestId,
          action,
          status: 'completed',
          memoryId: forgotten.id,
          candidateId,
          reason,
        };
      } else if (action === 'remember') {
        if (!candidateId) {
          throw new Error('记忆动作请求没有可接受的候选');
        }
        this.assertCandidateOwned(candidateId, ownerId);
        const resolution = this.candidateResolver.acceptForReview(
          candidateId,
          {
            content: cleanText(input.content) || undefined,
            value: cleanText(input.value) || undefined,
          },
        );
        memoryId = resolution.memoryId;
        reason = resolution.reason;
      } else if (action === 'correct') {
        if (!candidateId) {
          throw new Error('记忆动作请求没有可接受的候选');
        }
        this.assertCandidateOwned(candidateId, ownerId);
        const targetId =
          cleanText(input.memoryId) ||
          cleanText(claimed.target_memory_id);
        if (!targetId) {
          throw new Error('确认纠正时必须选择唯一目标记忆');
        }
        if (!this.memoryStore.get(targetId, true, ownerId)) {
          throw new Error('记忆不存在');
        }
        const resolution =
          this.candidateResolver.acceptCorrectionForReview(
            candidateId,
            targetId,
            this.actionRequestScopes(claimed, ownerId),
            {
              content: cleanText(input.content) || undefined,
              value: cleanText(input.value) || undefined,
            },
          );
        memoryId = resolution.memoryId;
        reason = resolution.reason;
      } else {
        throw new Error('记忆动作请求类型无效');
      }
      this.finishActionReview(
        requestId,
        token,
        'completed',
        memoryId,
        candidateId,
        reason,
        ownerId,
        cleanText(claimed.namespace),
        action,
      );
      return {
        requestId,
        action,
        status: 'completed',
        memoryId,
        candidateId,
        reason,
      };
    } catch (error) {
      this.releaseActionReview(requestId, token, ownerId);
      throw error;
    }
  }

  rejectMemoryActionRequest(
    requestId: string,
    blockFuture = false,
    userId = config.defaultUserId,
  ): MemoryActionReviewResult {
    const ownerId = cleanText(userId);
    const existing = this.actionRequestRow(requestId, ownerId);
    if (cleanText(existing.status) === 'rejected') {
      return this.actionReviewResult(
        existing,
        'manual_action_already_rejected',
      );
    }
    if (cleanText(existing.status) === 'completed') {
      throw new Error('已完成的记忆动作请求不能拒绝');
    }
    const claimed = this.claimActionRequest(requestId, ownerId);
    const token = cleanText(claimed.review_token);
    try {
      const action = cleanText(
        claimed.action,
      ) as MemoryActionReviewResult['action'];
      const candidateId = nullableText(claimed.candidate_id);
      if (candidateId) {
        this.assertCandidateOwned(candidateId, ownerId);
        this.candidateResolver.rejectForReview(
          candidateId,
          blockFuture,
        );
      }
      const reason = blockFuture && candidateId
        ? 'manual_action_rejected_and_tombstoned'
        : 'manual_action_rejected';
      this.finishActionReview(
        requestId,
        token,
        'rejected',
        null,
        candidateId,
        reason,
        ownerId,
        cleanText(claimed.namespace),
        action,
      );
      return {
        requestId,
        action,
        status: 'rejected',
        memoryId: null,
        candidateId,
        reason,
      };
    } catch (error) {
      this.releaseActionReview(requestId, token, ownerId);
      throw error;
    }
  }

  async restoreMemory(
    memoryId: string,
    input: RestoreMemoryInput = {},
    userId = config.defaultUserId,
  ): Promise<RestoreDecisionResult> {
    if (
      input.confirmation !== undefined &&
      input.confirmation !== 'replace'
    ) {
      throw new Error('恢复确认只允许 replace');
    }
    const ownerId = cleanText(userId);
    const memory = this.memoryStore.get(
      memoryId,
      true,
      ownerId,
    );
    if (!memory) throw new Error('记忆不存在');
    if (memory.status !== 'deleted') {
      return {
        status: 'restored',
        memory,
        conflicts: [],
        tombstonesRestored: 0,
        confirmationToken: null,
        assessment: null,
      };
    }
    const item = this.database
      .prepare(
        `SELECT stable_key, predicate_key, normalized_value_hash,
                normalized_value, predicate_cardinality, revision
         FROM memory_items
         WHERE id = ? AND user_id = ?`,
      )
      .get(memory.id, memory.userId) as DatabaseRow | undefined;
    if (!item) throw new Error('记忆真相项不存在');
    const predicateKey = cleanText(item.predicate_key);
    const predicateParts = predicateKey
      .split('::')
      .map((part) => cleanText(part))
      .filter(Boolean);
    const storedCardinality = cleanText(
      item.predicate_cardinality,
    );
    const cardinality: PredicateCardinality =
      storedCardinality === 'set' || storedCardinality === 'event'
        ? storedCardinality
        : 'single';
    const claim: ClaimSubject = {
      id: memory.id,
      userId: memory.userId,
      namespace: memory.namespace,
      kind: memory.kind,
      subject: predicateParts[0] || '用户',
      predicate:
        predicateParts.slice(1).join('::') ||
        predicateKey ||
        memory.kind,
      value:
        nullableText(item.normalized_value) ||
        memory.content,
      normalizedKey: predicateKey || cleanText(item.stable_key),
      normalizedHash:
        nullableText(item.normalized_value_hash) ||
        memory.checksum,
      stableKey: cleanText(item.stable_key) || `restore:${memory.id}`,
      content: memory.content,
      confidence: memory.confidence,
      importance: memory.importance,
      sensitivity: memory.sensitivity,
      negated: memory.negated,
      scopeType: memory.scopeType,
      scopeKey: memory.scopeKey,
      claimOccurredAt: memory.occurredAt,
      claimValidFrom: memory.validFrom,
      claimValidTo: memory.validTo,
      sourceAuthority: memory.sourceAuthority,
      explicitCorrection: false,
    };
    let assessment: ClaimRelationAssessment;
    try {
      assessment = await this.candidateResolver.assessClaim(
        claim,
        {
          excludeMemoryIds: [memory.id],
          cardinality,
        },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '未知错误';
      throw new MemoryAdminUnavailableError(
        `恢复关系评估不可用：${message}`,
        { cause: error },
      );
    }
    return this.memoryStore.commitRestore(
      memory.id,
      assessment,
      input,
      ownerId,
    );
  }

  private actionInboxItem(
    row: DatabaseRow,
  ): MemoryActionRequestInboxItem {
    const candidate = parseJson(row.candidate_json);
    return {
      id: cleanText(row.id),
      userId: cleanText(row.user_id),
      namespace: cleanText(row.namespace),
      action: cleanText(
        row.action,
      ) as MemoryActionRequestInboxItem['action'],
      status: cleanText(
        row.status,
      ) as MemoryActionRequestInboxItem['status'],
      targetQuery: cleanText(row.target_query),
      targetMemoryId: nullableText(row.target_memory_id),
      candidateId: nullableText(row.candidate_id),
      candidate:
        Object.keys(candidate).length > 0 ? candidate : null,
      turnId: nullableText(row.turn_id),
      turnContent: evidenceNullableText(row.turn_content),
      confidence: Number(row.confidence),
      sensitivity: cleanText(row.sensitivity),
      model: cleanText(row.model),
      promptVersion: cleanText(row.prompt_version),
      rationale: cleanText(row.rationale),
      error: nullableText(row.error),
      reviewInProgress: Boolean(nullableText(row.review_token)),
      createdAt: cleanText(row.created_at),
      resolvedAt: nullableText(row.resolved_at),
    };
  }

  private assertCandidateOwned(
    candidateId: string,
    userId: string,
  ): void {
    const row = this.database
      .prepare(
        `SELECT 1
         FROM memory_candidates
         WHERE id = ? AND user_id = ?`,
      )
      .get(
        cleanText(candidateId),
        cleanText(userId),
      );
    if (!row) throw new Error('候选记忆不存在');
  }

  private actionRequestScopes(
    actionRequest: DatabaseRow,
    userId: string,
  ): MemoryAccessScope[] {
    const turnId = cleanText(actionRequest.turn_id);
    if (!turnId) throw new Error('记忆动作请求缺少原始会话');
    const session = this.database
      .prepare(
        `SELECT
           s.user_id AS session_user_id,
           s.namespace AS session_namespace,
           s.external_id,
           s.persona_id,
           s.project_id,
           s.identity_status
         FROM conversation_turns t
         JOIN conversation_sessions s ON s.id = t.session_id
         WHERE t.id = ?
           AND t.user_id = ?
           AND t.namespace = ?`,
      )
      .get(
        turnId,
        cleanText(userId),
        cleanText(actionRequest.namespace),
      ) as DatabaseRow | undefined;
    if (
      !session ||
      cleanText(session.session_user_id) !== cleanText(userId) ||
      cleanText(session.session_namespace) !==
        cleanText(actionRequest.namespace)
    ) {
      throw new Error('记忆动作请求的原始会话不存在');
    }
    const scopes: MemoryAccessScope[] = [
      { scopeType: 'personal', scopeKey: 'self' },
    ];
    if (cleanText(session.identity_status) !== 'complete') {
      return scopes;
    }
    const personaId = cleanText(session.persona_id);
    const sessionExternalId = cleanText(session.external_id);
    if (!personaId || !sessionExternalId) {
      throw new Error('完整身份会话缺少可信 persona/session 绑定');
    }
    scopes.push(
      { scopeType: 'role', scopeKey: personaId },
      { scopeType: 'session', scopeKey: sessionExternalId },
    );
    const projectId = cleanText(session.project_id);
    if (projectId) {
      scopes.push({ scopeType: 'project', scopeKey: projectId });
    }
    return scopes;
  }

  private actionRequestRow(
    requestId: string,
    userId: string,
  ): DatabaseRow {
    const row = this.database
      .prepare(
        `SELECT *
         FROM memory_action_requests
         WHERE id = ? AND user_id = ?`,
      )
      .get(
        cleanText(requestId),
        cleanText(userId),
      ) as DatabaseRow | undefined;
    if (!row) throw new Error('记忆动作请求不存在');
    return row;
  }

  private claimActionRequest(
    requestId: string,
    userId: string,
  ): DatabaseRow {
    const token = randomUUID();
    const claimedAt = new Date().toISOString();
    const staleBefore = new Date(
      Date.now() - 5 * 60_000,
    ).toISOString();
    const result = this.database
      .prepare(
        `UPDATE memory_action_requests
         SET review_token = ?, review_claimed_at = ?
         WHERE id = ? AND user_id = ?
           AND status IN ('pending', 'failed')
           AND (
             review_token IS NULL
             OR review_claimed_at IS NULL
             OR review_claimed_at < ?
           )`,
      )
      .run(
        token,
        claimedAt,
        cleanText(requestId),
        cleanText(userId),
        staleBefore,
      );
    if (Number(result.changes) !== 1) {
      const row = this.actionRequestRow(requestId, userId);
      if (
        cleanText(row.status) === 'completed' ||
        cleanText(row.status) === 'rejected'
      ) {
        throw new Error('记忆动作请求已经处理');
      }
      throw new Error('记忆动作请求正在被其他审核处理');
    }
    return this.actionRequestRow(requestId, userId);
  }

  private releaseActionReview(
    requestId: string,
    token: string,
    userId: string,
  ): void {
    this.database
      .prepare(
        `UPDATE memory_action_requests
         SET review_token = NULL, review_claimed_at = NULL
         WHERE id = ? AND user_id = ? AND review_token = ?`,
      )
      .run(
        cleanText(requestId),
        cleanText(userId),
        token,
      );
  }

  private finishActionReview(
    requestId: string,
    token: string,
    status: 'completed' | 'rejected',
    memoryId: string | null,
    candidateId: string | null,
    reason: string,
    userId: string,
    namespace: string,
    action: MemoryActionReviewResult['action'],
  ): void {
    const result = this.database
      .prepare(
        `UPDATE memory_action_requests
         SET status = ?, target_memory_id = ?, candidate_id = ?,
             rationale = ?, error = NULL, resolved_at = ?,
             review_token = NULL, review_claimed_at = NULL
         WHERE id = ? AND user_id = ? AND namespace = ?
           AND action = ? AND status IN ('pending', 'failed')
           AND review_token = ?`,
      )
      .run(
        status,
        memoryId,
        candidateId,
        cleanText(reason),
        new Date().toISOString(),
        cleanText(requestId),
        cleanText(userId),
        cleanText(namespace),
        action,
        token,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('记忆动作审核租约已过期');
    }
  }

  private actionReviewResult(
    row: DatabaseRow,
    reason: string,
  ): MemoryActionReviewResult {
    return {
      requestId: cleanText(row.id),
      action: cleanText(
        row.action,
      ) as MemoryActionReviewResult['action'],
      status: cleanText(
        row.status,
      ) as MemoryActionReviewResult['status'],
      memoryId: nullableText(row.target_memory_id),
      candidateId: nullableText(row.candidate_id),
      reason,
    };
  }

  memoryDetail(
    memoryId: string,
    userId = config.defaultUserId,
  ): Record<string, unknown> | null {
    const ownerId = cleanText(userId);
    const memory = this.memoryStore.get(
      memoryId,
      true,
      ownerId,
    );
    if (!memory) return null;
    const governance = this.governance.get(memory.id, ownerId);
    const versionRows = this.database
      .prepare(
        `SELECT *
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version DESC`,
      )
      .all(memory.id) as DatabaseRow[];
    const versions = versionRows.map((row) => {
      const evidence = (
        this.database
          .prepare(
            `SELECT
               e.*,
               t.content AS turn_content,
               t.occurred_at AS turn_occurred_at,
               t.session_id
             FROM memory_evidence e
             LEFT JOIN conversation_turns t ON t.id = e.turn_id
             WHERE e.memory_version_id = ?
             ORDER BY e.created_at ASC`,
          )
          .all(cleanText(row.id)) as DatabaseRow[]
      ).map((entry) => ({
        id: cleanText(entry.id),
        evidenceType: cleanText(entry.evidence_type),
        excerpt: evidenceNullableText(entry.excerpt),
        sourceRef: nullableText(entry.source_ref),
        turnId: nullableText(entry.turn_id),
        turnContent: evidenceNullableText(entry.turn_content),
        turnOccurredAt: nullableText(entry.turn_occurred_at),
        sessionId: nullableText(entry.session_id),
        sensitivity: cleanText(entry.sensitivity),
        sourceAuthority: cleanText(entry.source_authority),
        createdAt: cleanText(entry.created_at),
      }));
      return {
        id: cleanText(row.id),
        version: Number(row.version),
        title: cleanText(row.title),
        content: cleanText(row.content),
        summary: cleanText(row.summary),
        importance: Number(row.importance),
        confidence: Number(row.confidence),
        source: cleanText(row.source),
        sourceRef: nullableText(row.source_ref),
        createdBy: cleanText(row.created_by),
        createdAt: cleanText(row.created_at),
        supersededAt: nullableText(row.superseded_at),
        predicateKey: nullableText(row.predicate_key),
        normalizedValue: nullableText(row.normalized_value),
        scopeType: cleanText(row.scope_type),
        scopeKey: cleanText(row.scope_key),
        sensitivity: cleanText(row.sensitivity),
        sourceAuthority: cleanText(row.source_authority),
        negated: Number(row.negated) === 1,
        occurredAt: nullableText(row.occurred_at),
        validFrom: nullableText(row.valid_from),
        validTo: nullableText(row.valid_to),
        evidence,
      };
    });
    const eventRows = this.database
      .prepare(
        `SELECT *
         FROM memory_events
         WHERE memory_item_id = ?
         ORDER BY created_at DESC`,
      )
      .all(memory.id) as DatabaseRow[];
    const relationDecisionRows = this.database
      .prepare(
        `SELECT
           r.*,
           c.content AS candidate_content,
           c.subject AS candidate_subject,
           c.predicate AS candidate_predicate,
           c.value_text AS candidate_value
         FROM candidate_resolution_runs r
         JOIN memory_candidates c ON c.id = r.candidate_id
         WHERE r.target_memory_item_id = ?
            OR c.resolved_memory_item_id = ?
         ORDER BY r.created_at DESC, r.id DESC`,
      )
      .all(memory.id, memory.id) as DatabaseRow[];
    const consolidation = this.consolidationDetail(
      memory.id,
      ownerId,
    );
    return {
      memory,
      governance,
      relations: this.memoryStore.relations(memory.id, ownerId),
      versions,
      events: eventRows.map((row) => ({
        id: cleanText(row.id),
        eventType: cleanText(row.event_type),
        payload: parseJson(row.payload_json),
        createdAt: cleanText(row.created_at),
      })),
      relationDecisions: relationDecisionRows.map((row) => ({
        id: cleanText(row.id),
        candidateId: cleanText(row.candidate_id),
        candidateContent: cleanText(row.candidate_content),
        candidateSubject: cleanText(row.candidate_subject),
        candidatePredicate: cleanText(row.candidate_predicate),
        candidateValue: cleanText(row.candidate_value),
        targetMemoryItemId: nullableText(row.target_memory_item_id),
        relation: cleanText(row.relation),
        method: cleanText(row.method),
        confidence: Number(row.confidence),
        model: nullableText(row.model),
        promptVersion: nullableText(row.prompt_version),
        rationale: cleanText(row.rationale),
        status: cleanText(row.status),
        error: nullableText(row.error),
        createdAt: cleanText(row.created_at),
      })),
      consolidation,
    };
  }

  pinMemory(
    memoryId: string,
    pinned: boolean,
    userId = config.defaultUserId,
  ):
  MemoryGovernanceRecord {
    return this.governance.setPinned(memoryId, pinned, userId);
  }

  archiveMemory(
    memoryId: string,
    reason?: string,
    userId = config.defaultUserId,
  ): MemoryGovernanceRecord {
    return this.governance.archiveMemory(
      memoryId,
      reason,
      userId,
    );
  }

  unarchiveMemory(
    memoryId: string,
    userId = config.defaultUserId,
  ): MemoryGovernanceRecord {
    return this.governance.unarchiveMemory(memoryId, userId);
  }

  setMemoryTtl(
    memoryId: string,
    expiresAt: string | null,
    userId = config.defaultUserId,
  ): MemoryGovernanceRecord {
    return this.governance.setTtl(
      memoryId,
      expiresAt,
      userId,
    );
  }

  revertMemory(
    memoryId: string,
    versionId: string,
    userId = config.defaultUserId,
  ) {
    return this.memoryStore.revertToVersion(
      memoryId,
      versionId,
      userId,
    );
  }

  listTombstones(
    limit = 200,
    userId = config.defaultUserId,
  ): Array<Record<string, unknown>> {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM memory_tombstones
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(
          cleanText(userId),
          Math.max(1, Math.min(limit, 500)),
        ) as DatabaseRow[]
    ).map((row) => ({
      id: cleanText(row.id),
      namespace: cleanText(row.namespace),
      stableKey: nullableText(row.stable_key),
      contentHash: nullableText(row.content_hash),
      reason: cleanText(row.reason),
      createdAt: cleanText(row.created_at),
      restoredAt: nullableText(row.restored_at),
    }));
  }

  listConsolidations(
    limit = 200,
    userId = config.defaultUserId,
  ): Array<Record<string, unknown>> {
    return (
      this.database
        .prepare(
          `SELECT
             d.*,
             m.title,
             m.status AS memory_status,
             (
               SELECT COUNT(*)
               FROM derived_consolidation_sources s
               WHERE s.consolidation_id = d.id
             ) AS source_count,
             (
               SELECT COUNT(*)
               FROM derived_consolidation_sentences s
               WHERE s.consolidation_id = d.id
             ) AS sentence_count
           FROM derived_consolidations d
           LEFT JOIN memories m ON m.id = d.memory_id
           WHERE d.user_id = ?
           ORDER BY d.generated_at DESC
           LIMIT ?`,
        )
        .all(
          cleanText(userId),
          Math.max(1, Math.min(limit, 500)),
        ) as DatabaseRow[]
    ).map((row) => ({
      id: cleanText(row.id),
      memoryId: nullableText(row.memory_id),
      namespace: cleanText(row.namespace),
      scopeType: cleanText(row.scope_type),
      scopeKey: cleanText(row.scope_key),
      sourceSetHash: cleanText(row.source_set_hash),
      model: cleanText(row.model),
      promptVersion: cleanText(row.prompt_version),
      status: cleanText(row.status),
      generatedAt: cleanText(row.generated_at),
      staleAt: nullableText(row.stale_at),
      lastError: nullableText(row.last_error),
      revision: Number(row.revision),
      title: nullableText(row.title),
      memoryStatus: nullableText(row.memory_status),
      sourceCount: Number(row.source_count),
      sentenceCount: Number(row.sentence_count),
    }));
  }

  listRecallExplanations(
    limit = 100,
    userId = config.defaultUserId,
  ):
  Array<Record<string, unknown>> {
    return this.memoryStore
      .audits(
        Math.max(1, Math.min(limit, 500)),
        0,
        cleanText(userId),
      )
      .filter((entry) => entry.action === 'recall')
      .map((entry) => ({
        id: entry.id,
        traceId: entry.detail.traceId,
        queryHash: entry.detail.queryHash,
        query: entry.detail.query,
        mode: entry.detail.mode,
        candidateCount: entry.detail.candidateCount,
        lexicalCandidateCount:
          entry.detail.lexicalCandidateCount,
        annCandidateCount: entry.detail.annCandidateCount,
        termCandidateCount: entry.detail.termCandidateCount,
        graphCandidateCount: entry.detail.graphCandidateCount,
        rerankCandidateCount:
          entry.detail.rerankCandidateCount,
        resultIds: entry.detail.resultIds,
        results: this.recallResultDetails(
          entry.detail.resultDetails,
          cleanText(userId),
        ),
        qualityState: entry.detail.qualityState,
        embeddingModel: entry.detail.embeddingModel,
        rerankModel: entry.detail.rerankModel,
        denseEligible: entry.detail.denseEligible,
        denseIndexed: entry.detail.denseIndexed,
        indexVersion: entry.detail.indexVersion,
        generationId: entry.detail.generationId,
        generationKey: entry.detail.generationKey,
        filterSummary: entry.detail.filterSummary,
        createdAt: entry.createdAt,
      }));
  }

  runMemoryDoctor(
    userId = config.defaultUserId,
    input: {
      sampleLimit?: number;
      oversizedCharacterThreshold?: number;
      zeroResultHotspotThreshold?: number;
    } = {},
  ): MemoryDoctorReport {
    const ownerId = cleanText(userId);
    const sampleLimit = Math.max(
      1,
      Math.min(input.sampleLimit || 20, 100),
    );
    const oversizedCharacterThreshold = Math.max(
      1_000,
      Math.min(input.oversizedCharacterThreshold || 12_000, 1_000_000),
    );
    const zeroResultHotspotThreshold = Math.max(
      2,
      Math.min(input.zeroResultHotspotThreshold || 3, 1_000),
    );
    const rows = (
      sql: string,
      ...values: Array<string | number>
    ): DatabaseRow[] => this.database.prepare(sql).all(
      ...values,
    ) as DatabaseRow[];
    const identifiers = (
      values: DatabaseRow[],
      key: string,
    ): string[] => values
      .map((row) => cleanText(row[key]))
      .filter(Boolean)
      .slice(0, sampleLimit);

    const duplicateStableKeys = rows(
      `SELECT MIN(id) AS sample_id, COUNT(*) AS count,
              SUM(COUNT(*)) OVER () AS total_count
       FROM memory_items
       WHERE user_id = ? AND status = 'active'
       GROUP BY namespace, scope_type, scope_key, stable_key
       HAVING COUNT(*) > 1
       ORDER BY count DESC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const activeConflicts = rows(
      `SELECT MIN(id) AS sample_id, COUNT(*) AS count,
              SUM(COUNT(*)) OVER () AS total_count
       FROM memory_items
       WHERE user_id = ?
         AND status = 'active'
         AND predicate_cardinality = 'single'
         AND TRIM(predicate_key) != ''
       GROUP BY namespace, scope_type, scope_key, predicate_key
       HAVING COUNT(DISTINCT normalized_value_hash) > 1
       ORDER BY count DESC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const unresolvedCandidates = rows(
      `SELECT id AS sample_id
       FROM memory_candidates
       WHERE user_id = ? AND state IN ('pending', 'conflicted')
       ORDER BY updated_at ASC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const unresolvedCount = Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates
           WHERE user_id = ? AND state IN ('pending', 'conflicted')`,
        )
        .get(ownerId)?.count || 0,
    );
    const orphanCurrentVersions = rows(
      `SELECT i.id AS sample_id
       FROM memory_items i
       LEFT JOIN memory_versions v ON v.id = i.current_version_id
       WHERE i.user_id = ?
         AND i.current_version_id IS NOT NULL
         AND v.id IS NULL
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const orphanEdges = rows(
      `SELECT e.id AS sample_id
       FROM memory_edges e
       LEFT JOIN memory_items source
         ON source.id = e.from_memory_item_id
       LEFT JOIN memory_items target
         ON target.id = e.to_memory_item_id
       WHERE (source.user_id = ? OR target.user_id = ?)
         AND (source.id IS NULL OR target.id IS NULL)
       LIMIT ?`,
      ownerId,
      ownerId,
      sampleLimit,
    );
    const staleConsolidations = rows(
      `SELECT id AS sample_id
       FROM derived_consolidations
       WHERE user_id = ? AND status = 'stale'
       ORDER BY generated_at ASC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const quarantinedConsolidations = rows(
      `SELECT id AS sample_id
       FROM derived_consolidations
       WHERE user_id = ? AND status = 'quarantined'
       ORDER BY generated_at ASC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const roleConstraintRows = rows(
      `SELECT i.id AS sample_id,
              m.content AS memory_content,
              COALESCE(v.content, '') AS version_content,
              COALESCE(GROUP_CONCAT(e.excerpt, '\n'), '') AS evidence_text
       FROM memory_items i
       JOIN memories m ON m.id = i.id
       LEFT JOIN memory_versions v ON v.id = i.current_version_id
       LEFT JOIN memory_evidence e ON e.memory_version_id = v.id
       WHERE i.user_id = ?
         AND i.status = 'active'
         AND m.status = 'active'
         AND m.source != 'consolidation'
         AND i.scope_type = 'personal'
         AND i.scope_key = 'self'
         AND (
           m.content LIKE '%角色%'
           OR v.content LIKE '%角色%'
           OR e.excerpt LIKE '%角色%'
         )
       GROUP BY i.id, m.content, v.content
       ORDER BY i.updated_at DESC`,
      ownerId,
    ).filter((row) =>
      namedRoleScopeNamesFromText([
        cleanText(row.memory_content),
        cleanText(row.version_content),
        cleanText(row.evidence_text),
      ].join('\n')).length > 0
    );
    const consolidationSourceRows = rows(
      `SELECT d.id AS consolidation_id,
              d.memory_id AS consolidation_memory_id,
              derived.scope_type AS derived_scope_type,
              derived.scope_key AS derived_scope_key,
              source_item.id AS source_memory_id,
              source_version.scope_type AS source_scope_type,
              source_version.scope_key AS source_scope_key,
              source_version.content AS source_content,
              COALESCE(GROUP_CONCAT(e.excerpt, '\n'), '') AS evidence_text,
              COALESCE(GROUP_CONCAT(session.persona_id, '\n'), '')
                AS evidence_persona_ids
       FROM derived_consolidations d
       LEFT JOIN memories derived ON derived.id = d.memory_id
       JOIN derived_consolidation_sources source_link
         ON source_link.consolidation_id = d.id
       JOIN memory_versions source_version
         ON source_version.id = source_link.memory_version_id
       JOIN memory_items source_item
         ON source_item.id = source_version.memory_item_id
       LEFT JOIN memory_evidence e
         ON e.memory_version_id = source_version.id
       LEFT JOIN conversation_turns turn ON turn.id = e.turn_id
       LEFT JOIN conversation_sessions session
         ON session.id = turn.session_id
        AND session.user_id = d.user_id
        AND session.namespace = d.namespace
       WHERE d.user_id = ? AND d.status = 'active'
       GROUP BY
         d.id, d.memory_id, derived.scope_type, derived.scope_key,
         source_item.id, source_version.id, source_version.scope_type,
         source_version.scope_key, source_version.content
       ORDER BY d.generated_at DESC, d.id, source_version.id`,
      ownerId,
    );
    const consolidationSignals = new Map<string, {
      sampleId: string;
      derivedScope: string;
      sourceScopes: Set<string>;
      roleEvidencePersonas: Set<string>;
      hasRoleConstraint: boolean;
    }>();
    for (const row of consolidationSourceRows) {
      const id = cleanText(row.consolidation_id);
      if (!id) continue;
      const signal = consolidationSignals.get(id) || {
        sampleId: id,
        derivedScope: [
          cleanText(row.derived_scope_type),
          cleanText(row.derived_scope_key),
        ].join('\u0000'),
        sourceScopes: new Set<string>(),
        roleEvidencePersonas: new Set<string>(),
        hasRoleConstraint: false,
      };
      signal.sourceScopes.add([
        cleanText(row.source_scope_type),
        cleanText(row.source_scope_key),
      ].join('\u0000'));
      const sourceEvidence = [
        cleanText(row.source_content),
        cleanText(row.evidence_text),
      ].join('\n');
      if (namedRoleScopeNamesFromText(sourceEvidence).length > 0) {
        signal.hasRoleConstraint = true;
        for (const personaId of cleanText(row.evidence_persona_ids)
          .split('\n')
          .map(cleanText)
          .filter(Boolean)) {
          signal.roleEvidencePersonas.add(personaId);
        }
      }
      consolidationSignals.set(id, signal);
    }
    const mixedRoleConsolidations = [...consolidationSignals.values()]
      .filter((signal) =>
        signal.sourceScopes.size > 1 ||
        [...signal.sourceScopes].some(
          (scope) => scope !== signal.derivedScope,
        ) ||
        signal.roleEvidencePersonas.size > 1 ||
        (
          signal.hasRoleConstraint &&
          signal.derivedScope === 'personal\u0000self'
        )
      )
      .map((signal) => ({ sample_id: signal.sampleId }));
    const oversizedMemories = rows(
      `SELECT id AS sample_id
       FROM memories
       WHERE user_id = ?
         AND status IN ('active', 'archived')
         AND length(content) > ?
       ORDER BY length(content) DESC
       LIMIT ?`,
      ownerId,
      oversizedCharacterThreshold,
      sampleLimit,
    );
    const unindexedEpisodes = rows(
      `SELECT e.id AS sample_id, COUNT(*) OVER () AS total_count
       FROM conversation_episodes e
       JOIN memories m ON m.id = e.memory_id
       WHERE e.user_id = ? AND e.status = 'active'
         AND m.status = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM memory_embeddings embedding
           JOIN dense_index_aliases alias
             ON alias.user_id = e.user_id
            AND alias.namespace = e.namespace
           WHERE embedding.memory_id = e.memory_id
             AND embedding.generation_id = alias.active_generation_id
             AND embedding.memory_revision = m.semantic_revision
         )
       ORDER BY e.occurred_at ASC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const incompleteSummarySources = rows(
      `SELECT summary.id AS sample_id,
              COUNT(*) OVER () AS total_count
       FROM conversation_memory_summaries summary
       LEFT JOIN conversation_memory_summary_sources source
         ON source.summary_id = summary.id
       LEFT JOIN conversation_episodes episode
         ON episode.id = source.episode_id
        AND episode.user_id = summary.user_id
        AND episode.namespace = summary.namespace
       WHERE summary.user_id = ? AND summary.status = 'active'
       GROUP BY summary.id, summary.source_count
       HAVING COUNT(episode.id) != summary.source_count
       ORDER BY summary.updated_at ASC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const patternObservationScopeMismatches = rows(
      `SELECT observation.id AS sample_id,
              COUNT(*) OVER () AS total_count
       FROM memory_pattern_observations observation
       LEFT JOIN conversation_turns turn
         ON turn.id = observation.turn_id
       LEFT JOIN conversation_sessions session
         ON session.id = turn.session_id
       LEFT JOIN memory_reflection_runs first_run
         ON first_run.id = observation.first_run_id
       LEFT JOIN memory_reflection_runs last_run
         ON last_run.id = observation.last_run_id
       WHERE (
           observation.user_id = ? OR turn.user_id = ? OR session.user_id = ?
         )
         AND (
           turn.id IS NULL OR session.id IS NULL
           OR observation.user_id != turn.user_id
           OR observation.namespace != turn.namespace
           OR observation.session_id != turn.session_id
           OR session.user_id != turn.user_id
           OR session.namespace != turn.namespace
           OR (observation.scope_type = 'personal'
               AND observation.scope_key != 'self')
           OR (observation.scope_type = 'role'
               AND observation.scope_key != COALESCE(session.persona_id, ''))
           OR (observation.scope_type = 'project'
               AND observation.scope_key != COALESCE(session.project_id, ''))
           OR (observation.scope_type = 'session'
               AND observation.scope_key != session.external_id)
           OR (observation.first_run_id IS NOT NULL AND (
               first_run.id IS NULL
               OR first_run.user_id != observation.user_id
               OR first_run.namespace != observation.namespace
               OR first_run.scope_type != observation.scope_type
               OR first_run.scope_key != observation.scope_key
             ))
           OR (observation.last_run_id IS NOT NULL AND (
               last_run.id IS NULL
               OR last_run.user_id != observation.user_id
               OR last_run.namespace != observation.namespace
               OR last_run.scope_type != observation.scope_type
               OR last_run.scope_key != observation.scope_key
             ))
         )
       ORDER BY observation.updated_at ASC, observation.id ASC
       LIMIT ?`,
      ownerId,
      ownerId,
      ownerId,
      sampleLimit,
    );
    const layeredJobPredicate = `(
      job.job_type IN ('materialize_episode', 'summarize_memory_bucket')
      OR (
        job.job_type = 'index_memory'
        AND (
          EXISTS (
            SELECT 1 FROM conversation_episodes episode
            WHERE episode.memory_id = json_extract(
              job.payload_json, '$.memoryId'
            )
              AND episode.user_id = job.user_id
              AND episode.namespace = job.namespace
          )
          OR EXISTS (
            SELECT 1 FROM conversation_memory_summaries summary
            WHERE summary.memory_id = json_extract(
              job.payload_json, '$.memoryId'
            )
              AND summary.user_id = job.user_id
              AND summary.namespace = job.namespace
          )
        )
      )
    )`;
    const now = new Date().toISOString();
    const layeredJobBacklog = rows(
      `SELECT job.id AS sample_id, COUNT(*) OVER () AS total_count
       FROM memory_jobs job
       WHERE job.user_id = ?
         AND ${layeredJobPredicate}
         AND (
           (job.status = 'pending' AND job.available_at <= ?)
           OR (
             job.status = 'running'
             AND (job.lease_until IS NULL OR job.lease_until <= ?)
           )
         )
       ORDER BY job.available_at ASC, job.id ASC
       LIMIT ?`,
      ownerId,
      now,
      now,
      sampleLimit,
    );
    const layeredJobFailed = rows(
      `SELECT job.id AS sample_id, COUNT(*) OVER () AS total_count
       FROM memory_jobs job
       WHERE job.user_id = ? AND job.status = 'failed'
         AND ${layeredJobPredicate}
       ORDER BY job.updated_at ASC, job.id ASC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const layeredJobDead = rows(
      `SELECT job.id AS sample_id, COUNT(*) OVER () AS total_count
       FROM memory_jobs job
       WHERE job.user_id = ? AND job.status = 'dead'
         AND ${layeredJobPredicate}
       ORDER BY job.updated_at ASC, job.id ASC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const zeroResultHotspots = rows(
      `SELECT query_hash AS sample_id, COUNT(*) AS count,
              SUM(COUNT(*)) OVER () AS total_count
       FROM retrieval_traces
       WHERE user_id = ?
         AND completed_at IS NOT NULL
         AND result_count = 0
         AND started_at >= datetime('now', '-30 days')
       GROUP BY query_hash
       HAVING COUNT(*) >= ?
       ORDER BY count DESC
       LIMIT ?`,
      ownerId,
      zeroResultHotspotThreshold,
      sampleLimit,
    );
    const reflectionOrphanRunTurns = rows(
      `SELECT rt.run_id || ':' || rt.turn_id AS sample_id
       FROM memory_reflection_run_turns rt
       LEFT JOIN memory_reflection_runs r ON r.id = rt.run_id
       LEFT JOIN conversation_turns t ON t.id = rt.turn_id
       WHERE (r.user_id = ? OR t.user_id = ?)
         AND (r.id IS NULL OR t.id IS NULL)
       LIMIT ?`,
      ownerId,
      ownerId,
      sampleLimit,
    );
    const reflectionOrphanCandidateEvidence = rows(
      `SELECT e.candidate_id || ':' || e.turn_id AS sample_id
       FROM memory_candidate_evidence e
       LEFT JOIN memory_candidates c ON c.id = e.candidate_id
       LEFT JOIN conversation_turns t ON t.id = e.turn_id
       WHERE e.user_id = ? AND (c.id IS NULL OR t.id IS NULL)
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const reflectionRunTurnScopeMismatch = rows(
      `SELECT rt.run_id || ':' || rt.turn_id AS sample_id
       FROM memory_reflection_run_turns rt
       JOIN memory_reflection_runs r ON r.id = rt.run_id
       JOIN conversation_turns t ON t.id = rt.turn_id
       WHERE r.user_id = ?
         AND (t.user_id != r.user_id OR t.namespace != r.namespace)
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const reflectionEvidenceScopeMismatch = rows(
      `SELECT e.candidate_id || ':' || e.turn_id AS sample_id
       FROM memory_candidate_evidence e
       JOIN memory_candidates c ON c.id = e.candidate_id
       JOIN conversation_turns t ON t.id = e.turn_id
       WHERE c.user_id = ?
         AND (
           e.user_id != c.user_id OR e.namespace != c.namespace
           OR e.scope_type != c.scope_type OR e.scope_key != c.scope_key
           OR t.user_id != c.user_id OR t.namespace != c.namespace
         )
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const reflectionClaimScopeMismatch = rows(
      `SELECT claim.claim_fingerprint AS sample_id
       FROM memory_reflection_claims claim
       LEFT JOIN memory_candidates c ON c.id = claim.candidate_id
       LEFT JOIN memory_reflection_runs first_run
         ON first_run.id = claim.first_run_id
       LEFT JOIN memory_reflection_runs last_run
         ON last_run.id = claim.last_run_id
       WHERE claim.user_id = ?
         AND (
           first_run.id IS NULL OR last_run.id IS NULL
           OR first_run.user_id != claim.user_id
           OR first_run.namespace != claim.namespace
           OR first_run.scope_type != claim.scope_type
           OR first_run.scope_key != claim.scope_key
           OR last_run.user_id != claim.user_id
           OR last_run.namespace != claim.namespace
           OR last_run.scope_type != claim.scope_type
           OR last_run.scope_key != claim.scope_key
           OR (
             c.id IS NOT NULL AND (
               c.user_id != claim.user_id OR c.namespace != claim.namespace
               OR c.scope_type != claim.scope_type
               OR c.scope_key != claim.scope_key
             )
           )
         )
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const reflectionScopeMismatches = [
      ...reflectionRunTurnScopeMismatch,
      ...reflectionEvidenceScopeMismatch,
      ...reflectionClaimScopeMismatch,
    ].slice(0, sampleLimit);
    const reflectionCheckpointAhead = rows(
      `SELECT checkpoint.id AS sample_id
       FROM memory_reflection_checkpoints checkpoint
       WHERE checkpoint.user_id = ?
         AND (
           checkpoint.last_ingest_seq > COALESCE((
             SELECT MAX(ingest.ingest_seq)
             FROM memory_turn_ingest_order ingest
             WHERE ingest.user_id = checkpoint.user_id
               AND ingest.namespace = checkpoint.namespace
           ), 0)
           OR (
             checkpoint.last_turn_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM memory_turn_ingest_order ingest
               WHERE ingest.turn_id = checkpoint.last_turn_id
                 AND ingest.user_id = checkpoint.user_id
                 AND ingest.namespace = checkpoint.namespace
                 AND ingest.ingest_seq = checkpoint.last_ingest_seq
             )
           )
         )
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const reflectionStuckRuns = rows(
      `SELECT id AS sample_id
       FROM memory_reflection_runs
       WHERE user_id = ? AND status = 'running'
         AND (lease_until IS NULL OR lease_until < ?)
       LIMIT ?`,
      ownerId,
      now,
      sampleLimit,
    );
    const reflectionReservedModelCalls = rows(
      `SELECT call.id AS sample_id
       FROM memory_reflection_model_calls call
       LEFT JOIN memory_reflection_runs run ON run.id = call.run_id
       WHERE call.user_id = ? AND call.status = 'reserved'
         AND (
           run.id IS NULL OR run.status != 'running'
           OR run.lease_until IS NULL OR run.lease_until < ?
         )
       LIMIT ?`,
      ownerId,
      now,
      sampleLimit,
    );
    const reflectionDuplicateClaims = rows(
      `SELECT MIN(id) AS sample_id, COUNT(*) AS count,
              SUM(COUNT(*)) OVER () AS total_count
       FROM memory_candidates
       WHERE user_id = ?
         AND claim_fingerprint IS NOT NULL
         AND state IN ('pending', 'conflicted', 'accepted')
       GROUP BY namespace, scope_type, scope_key, claim_fingerprint
       HAVING COUNT(*) > 1
       ORDER BY count DESC
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const reflectionInvalidContentHashes = rows(
      `SELECT turn.run_id || ':' || turn.turn_id AS sample_id
       FROM memory_reflection_run_turns turn
       JOIN memory_reflection_runs run ON run.id = turn.run_id
       JOIN conversation_turns source ON source.id = turn.turn_id
       WHERE run.user_id = ?
         AND source.content NOT IN ('[purged]', '[retention-redacted]')
         AND turn.content_hash != source.content_hash
       LIMIT ?`,
      ownerId,
      sampleLimit,
    );
    const total = (values: DatabaseRow[]): number => {
      if (values.length === 0) return 0;
      const aggregate = Number(values[0].total_count);
      if (Number.isFinite(aggregate)) return aggregate;
      return values.reduce(
        (sum, row) => sum + Math.max(1, Number(row.count) || 1),
        0,
      );
    };
    const issues: MemoryDoctorIssue[] = [
      {
        category: 'duplicate_stable_key',
        severity: 'critical',
        count: total(duplicateStableKeys),
        sampleIds: identifiers(duplicateStableKeys, 'sample_id'),
        recommendation: '人工合并重复真相项并保留版本/证据链。',
      },
      {
        category: 'active_single_value_conflict',
        severity: 'critical',
        count: total(activeConflicts),
        sampleIds: identifiers(activeConflicts, 'sample_id'),
        recommendation: '进入冲突审核，只保留一个当前单值事实。',
      },
      {
        category: 'unresolved_candidate',
        severity: 'warning',
        count: unresolvedCount,
        sampleIds: identifiers(unresolvedCandidates, 'sample_id'),
        recommendation: '检查候选收件箱的 pending/conflicted 项。',
      },
      {
        category: 'orphan_current_version',
        severity: 'critical',
        count: orphanCurrentVersions.length,
        sampleIds: identifiers(orphanCurrentVersions, 'sample_id'),
        recommendation: '从备份恢复缺失版本或隔离受损真相项。',
      },
      {
        category: 'orphan_edge',
        severity: 'critical',
        count: orphanEdges.length,
        sampleIds: identifiers(orphanEdges, 'sample_id'),
        recommendation: '重建关系索引并调查外键被绕过的写入。',
      },
      {
        category: 'episode_dense_unindexed',
        severity: 'warning',
        count: total(unindexedEpisodes),
        sampleIds: identifiers(unindexedEpisodes, 'sample_id'),
        recommendation: '检查 index_memory 积压或失败并补建情景 Dense 索引。',
      },
      {
        category: 'summary_source_incomplete',
        severity: 'critical',
        count: total(incompleteSummarySources),
        sampleIds: identifiers(incompleteSummarySources, 'sample_id'),
        recommendation: '隔离来源断链摘要并从仍有效的情景重新生成。',
      },
      {
        category: 'pattern_observation_scope_mismatch',
        severity: 'critical',
        count: total(patternObservationScopeMismatches),
        sampleIds: identifiers(
          patternObservationScopeMismatches,
          'sample_id',
        ),
        recommendation: '停止反思晋升，隔离 owner、namespace、session 或 scope 错配观察。',
      },
      {
        category: 'layered_job_backlog',
        severity: 'warning',
        count: total(layeredJobBacklog),
        sampleIds: identifiers(layeredJobBacklog, 'sample_id'),
        recommendation: '检查到期情景、摘要或其 Dense 任务的 Worker 租约与吞吐。',
      },
      {
        category: 'layered_job_failed',
        severity: 'warning',
        count: total(layeredJobFailed),
        sampleIds: identifiers(layeredJobFailed, 'sample_id'),
        recommendation: '按 last_error 修复分层任务后等待有界重试，不得跳过可靠水位。',
      },
      {
        category: 'layered_job_dead',
        severity: 'critical',
        count: total(layeredJobDead),
        sampleIds: identifiers(layeredJobDead, 'sample_id'),
        recommendation: '从 dead letter 明确选择重算、修复或取代，并保留恢复审计。',
      },
      {
        category: 'stale_consolidation',
        severity: 'warning',
        count: staleConsolidations.length,
        sampleIds: identifiers(staleConsolidations, 'sample_id'),
        recommendation: '重新生成派生摘要，确认来源版本仍有效。',
      },
      {
        category: 'quarantined_consolidation',
        severity: 'warning',
        count: quarantinedConsolidations.length,
        sampleIds: identifiers(quarantinedConsolidations, 'sample_id'),
        recommendation: '查看 last_error 和逐句来源后人工处理。',
      },
      {
        category: 'role_constraint_in_personal_scope',
        severity: 'critical',
        count: roleConstraintRows.length,
        sampleIds: identifiers(roleConstraintRows, 'sample_id'),
        recommendation:
          '运行 schema 28 长记忆修复工具；可唯一映射时迁移到可信 role，无法映射时隔离。',
      },
      {
        category: 'mixed_role_consolidation',
        severity: 'critical',
        count: mixedRoleConsolidations.length,
        sampleIds: identifiers(mixedRoleConsolidations, 'sample_id'),
        recommendation:
          '失效混合角色摘要及其索引，按完全一致的 access scope 重新巩固。',
      },
      {
        category: 'oversized_memory',
        severity: 'warning',
        count: oversizedMemories.length,
        sampleIds: identifiers(oversizedMemories, 'sample_id'),
        recommendation: '拆分为原子事实，避免单条记忆挤占上下文预算。',
      },
      {
        category: 'zero_result_hotspot',
        severity: 'info',
        count: total(zeroResultHotspots),
        sampleIds: identifiers(zeroResultHotspots, 'sample_id'),
        recommendation: '从 trace 检查改写、通道候选和过滤门槛。',
      },
      {
        category: 'reflection_orphan_run_turn',
        severity: 'critical',
        count: reflectionOrphanRunTurns.length,
        sampleIds: identifiers(reflectionOrphanRunTurns, 'sample_id'),
        recommendation: '隔离孤儿 run-turn，并从完整备份重建不可变窗口。',
      },
      {
        category: 'reflection_orphan_candidate_evidence',
        severity: 'critical',
        count: reflectionOrphanCandidateEvidence.length,
        sampleIds: identifiers(
          reflectionOrphanCandidateEvidence,
          'sample_id',
        ),
        recommendation: '隔离无候选或无来源 turn 的 reflection 证据。',
      },
      {
        category: 'reflection_scope_mismatch',
        severity: 'critical',
        count: reflectionScopeMismatches.length,
        sampleIds: identifiers(reflectionScopeMismatches, 'sample_id'),
        recommendation: '停止 reflection Worker，隔离跨租户或跨 scope 引用。',
      },
      {
        category: 'reflection_checkpoint_ahead',
        severity: 'critical',
        count: reflectionCheckpointAhead.length,
        sampleIds: identifiers(reflectionCheckpointAhead, 'sample_id'),
        recommendation: '把异常水位回退到最近已验证 run 后重新增量扫描。',
      },
      {
        category: 'reflection_stuck_run',
        severity: 'warning',
        count: reflectionStuckRuns.length,
        sampleIds: identifiers(reflectionStuckRuns, 'sample_id'),
        recommendation: '确认旧 Worker 已退出后释放过期租约并重试。',
      },
      {
        category: 'reflection_reserved_model_call',
        severity: 'warning',
        count: reflectionReservedModelCalls.length,
        sampleIds: identifiers(
          reflectionReservedModelCalls,
          'sample_id',
        ),
        recommendation: '核对模型请求是否已发出；无法证明未调用时保守计入预算。',
      },
      {
        category: 'reflection_duplicate_claim',
        severity: 'critical',
        count: total(reflectionDuplicateClaims),
        sampleIds: identifiers(reflectionDuplicateClaims, 'sample_id'),
        recommendation: '合并同 scope 的活跃 claim 候选与证据，只保留单写者。',
      },
      {
        category: 'reflection_invalid_content_hash',
        severity: 'critical',
        count: reflectionInvalidContentHashes.length,
        sampleIds: identifiers(
          reflectionInvalidContentHashes,
          'sample_id',
        ),
        recommendation: '停止提交该 run，按原始 turn 重新建立窗口和内容哈希。',
      },
    ];
    return {
      userId: ownerId,
      status: issues.some(
        (issue) => issue.count > 0 && issue.severity !== 'info',
      )
        ? 'needs_attention'
        : 'healthy',
      issues,
      generatedAt: new Date().toISOString(),
      destructiveActionsTaken: 0,
    };
  }

  systemHealth(input: {
    ollamaAvailable: boolean;
    availableModels?: string[];
    chatModel?: string;
  }, userId = config.defaultUserId): SystemHealthSnapshot {
    const ownerId = cleanText(userId);
    const queueRows = this.database
      .prepare(
        `SELECT
           job_type,
           status,
           COUNT(*) AS count,
           MIN(available_at) AS oldest_available_at
         FROM memory_jobs
         WHERE user_id = ?
           AND status IN ('pending', 'running', 'failed')
         GROUP BY job_type, status
         ORDER BY job_type ASC, status ASC`,
      )
      .all(ownerId) as DatabaseRow[];
    const candidateRows = this.database
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM memory_candidates
         WHERE user_id = ?
         GROUP BY state`,
      )
      .all(ownerId) as DatabaseRow[];
    const candidateCounts: Record<string, number> = {};
    for (const row of candidateRows) {
      candidateCounts[cleanText(row.state)] = Number(row.count);
    }
    const index = this.database
      .prepare(
        `SELECT
           (
             SELECT COUNT(*)
             FROM memories
             WHERE user_id = ? AND status = 'active'
           ) AS active_memories,
           (
             SELECT COUNT(DISTINCT f.memory_id)
             FROM memories_fts f
             JOIN memories m ON m.id = f.memory_id
             WHERE m.user_id = ? AND m.status = 'active'
           ) AS fts_memories,
           (
             SELECT COUNT(DISTINCT a.memory_id)
             FROM memory_ann_index a
             JOIN memories m ON m.id = a.memory_id
             WHERE m.user_id = ? AND m.status = 'active'
           ) AS ann_memories,
           (
             SELECT COUNT(DISTINCT t.memory_id)
             FROM memory_term_index t
             JOIN memories m ON m.id = t.memory_id
             WHERE m.user_id = ? AND m.status = 'active'
           ) AS term_memories,
           (
             SELECT COUNT(DISTINCT e.memory_id)
             FROM memory_embeddings e
             JOIN memories m ON m.id = e.memory_id
             WHERE m.user_id = ? AND m.status = 'active'
           ) AS embedding_memories`,
      )
      .get(
        ownerId,
        ownerId,
        ownerId,
        ownerId,
        ownerId,
      ) as DatabaseRow;
    const extraction = this.database
      .prepare(
        `SELECT
           AVG(
             (julianday(completed_at) - julianday(created_at))
             * 86400000
           ) AS average_latency_ms,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)
             AS failed_count
         FROM extraction_runs
         WHERE turn_id IN (
           SELECT id
           FROM conversation_turns
           WHERE user_id = ?
         )`,
      )
      .get(ownerId) as DatabaseRow;
    const automation = this.database
      .prepare(
        `SELECT
           (
             SELECT COUNT(*)
             FROM memory_jobs
             WHERE (
                 user_id = ?
                 OR (
                   user_id = ? AND namespace = ?
                   AND job_type = 'consolidation_sweep'
                 )
               )
               AND status = 'failed'
           ) AS retrying_job_count,
           (
             SELECT COUNT(*)
             FROM derived_consolidations
             WHERE user_id = ? AND status = 'stale'
           ) AS stale_count,
           (
             SELECT COUNT(*)
             FROM derived_consolidations
             WHERE user_id = ? AND status = 'quarantined'
           ) AS quarantined_count`,
      )
      .get(
        ownerId,
        SYSTEM_JOB_USER_ID,
        SYSTEM_JOB_NAMESPACE,
        ownerId,
        ownerId,
      ) as DatabaseRow;
    const systemSweepRows = this.database
      .prepare(
        `SELECT id, status, attempts, max_attempts, lease_until,
                updated_at
         FROM memory_jobs
         WHERE job_type = 'consolidation_sweep'
           AND user_id = ? AND namespace = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(
        SYSTEM_JOB_USER_ID,
        SYSTEM_JOB_NAMESPACE,
      ) as DatabaseRow[];
    const nowMs = Date.now();
    const activeSystemSweep = systemSweepRows.find((row) => {
      if (!isCanonicalConsolidationSweepJobId(cleanText(row.id))) {
        return false;
      }
      const status = cleanText(row.status);
      const attempts = Number(row.attempts);
      const maxAttempts = Number(row.max_attempts);
      if (
        (status === 'pending' || status === 'failed') &&
        attempts < maxAttempts
      ) {
        return true;
      }
      if (status !== 'running') return false;
      if (attempts < maxAttempts) return true;
      const leaseUntil = nullableText(row.lease_until);
      return Boolean(leaseUntil && Date.parse(leaseUntil) > nowMs);
    });
    const completedSystemSweeps = systemSweepRows.filter(
      (row) =>
        cleanText(row.status) === 'completed' &&
        isCanonicalConsolidationSweepJobId(cleanText(row.id)),
    );
    const deadLetterRows = this.database
      .prepare(
        `SELECT job_id, job_type, user_id, namespace, attempts,
                last_error, failed_at
         FROM dead_letter_jobs
         WHERE user_id = ?
            OR (
              job_type = 'consolidation_sweep'
              AND user_id = ? AND namespace = ?
            )
         ORDER BY failed_at DESC`,
      )
      .all(
        ownerId,
        SYSTEM_JOB_USER_ID,
        SYSTEM_JOB_NAMESPACE,
      ) as DatabaseRow[];
    const deadLetters = deadLetterRows.map((row) => {
      const jobId = cleanText(row.job_id);
      const jobType = cleanText(row.job_type);
      const rowOwnerId = cleanText(row.user_id);
      const namespace = cleanText(row.namespace);
      const canonicalSweep =
        jobType === 'consolidation_sweep' &&
        isCanonicalConsolidationSweepJobId(jobId);
      const failedAt = cleanText(row.failed_at);
      const stableSystemTakeover =
        canonicalSweep &&
        rowOwnerId !== SYSTEM_JOB_USER_ID &&
        Boolean(activeSystemSweep) &&
        completedSystemSweeps.some(
          (completed) =>
            Date.parse(cleanText(completed.updated_at)) >=
            Date.parse(failedAt),
        );
      if (stableSystemTakeover) {
        return {
          jobId,
          jobType,
          namespace,
          attempts: Number(row.attempts),
          lastError: cleanText(row.last_error),
          failedAt,
          resolved: true,
          recoveryJobId: cleanText(activeSystemSweep?.id),
          recoveryStatus: cleanText(activeSystemSweep?.status),
          recoveryMode: 'system_takeover' as const,
        };
      }
      const recoveryCandidates = canonicalSweep
        ? [
            {
              id: consolidationSweepSuccessorId(jobId),
              mode: 'system_takeover' as const,
              jobType: 'consolidation_sweep',
            },
            {
              id: deadLetterRecoveryJobId(jobId, 'recompute'),
              mode: 'recompute' as const,
              jobType,
            },
            {
              id: deadLetterRecoveryJobId(jobId, 'repair'),
              mode: 'repair' as const,
              jobType,
            },
            {
              id: deadLetterRecoveryJobId(jobId, 'supersede'),
              mode: 'supersede' as const,
              jobType: 'dead_letter_supersede',
            },
          ]
        : [
            {
              id: deadLetterRecoveryJobId(jobId, 'recompute'),
              mode: 'recompute' as const,
              jobType,
            },
            {
              id: deadLetterRecoveryJobId(jobId, 'repair'),
              mode: 'repair' as const,
              jobType,
            },
            {
              id: deadLetterRecoveryJobId(jobId, 'supersede'),
              mode: 'supersede' as const,
              jobType: 'dead_letter_supersede',
            },
          ];
      let recoverySelection: {
        id: string;
        mode: DeadLetterRecoveryMode | 'system_takeover';
        row: DatabaseRow;
      } | null = null;
      for (const descriptor of recoveryCandidates) {
        const candidateRow = this.database
          .prepare(
            `SELECT status, updated_at
             FROM memory_jobs
             WHERE id = ? AND job_type = ?
               AND user_id = ? AND namespace = ?`,
          )
          .get(
            descriptor.id,
            descriptor.jobType,
            rowOwnerId,
            namespace,
          ) as DatabaseRow | undefined;
        if (!candidateRow) continue;
        if (
          recoverySelection &&
          Date.parse(cleanText(recoverySelection.row.updated_at)) >=
            Date.parse(cleanText(candidateRow.updated_at))
        ) {
          continue;
        }
        recoverySelection = {
          id: descriptor.id,
          mode: descriptor.mode,
          row: candidateRow,
        };
      }
      const generationRows = this.database
        .prepare(
          `SELECT id, status, updated_at,
                  json_extract(payload_json, '$.recovery.mode') AS mode
           FROM memory_jobs
           WHERE user_id = ? AND namespace = ?
             AND json_extract(payload_json, '$.recovery.failedJobId') = ?
           ORDER BY updated_at DESC, id DESC`,
        )
        .all(rowOwnerId, namespace, jobId) as DatabaseRow[];
      for (const candidateRow of generationRows) {
        const candidateMode = cleanText(candidateRow.mode) as
          DeadLetterRecoveryMode;
        if (!['recompute', 'repair', 'supersede'].includes(candidateMode)) {
          continue;
        }
        if (
          recoverySelection &&
          Date.parse(cleanText(recoverySelection.row.updated_at)) >=
            Date.parse(cleanText(candidateRow.updated_at))
        ) {
          continue;
        }
        recoverySelection = {
          id: cleanText(candidateRow.id),
          mode: candidateMode,
          row: candidateRow,
        };
      }
      return {
        jobId,
        jobType,
        namespace,
        attempts: Number(row.attempts),
        lastError: cleanText(row.last_error),
        failedAt,
        resolved:
          cleanText(recoverySelection?.row.status) === 'completed',
        recoveryJobId: recoverySelection?.id || null,
        recoveryStatus: recoverySelection
          ? cleanText(recoverySelection.row.status)
          : null,
        recoveryMode: recoverySelection?.mode || null,
      };
    });
    const jobAttemptRows = this.database
      .prepare(
        `SELECT action, detail_json, created_at
         FROM audit_log
         WHERE action IN ('job_attempt_completed', 'job_attempt_failed')
           AND (
             user_id = ?
             OR (
               user_id = ?
               AND json_extract(detail_json, '$.jobType') =
                 'consolidation_sweep'
             )
           )
         ORDER BY id DESC
         LIMIT 30`,
      )
      .all(ownerId, SYSTEM_JOB_USER_ID) as DatabaseRow[];
    const jobAttempts = jobAttemptRows.map((row) => {
      const detail = parseJson(row.detail_json);
      const missingSourceIds = Array.isArray(detail.missingSourceIds)
        ? detail.missingSourceIds
            .map((value) => cleanText(value))
            .filter(Boolean)
        : [];
      const modelDuration = typeof detail.modelDurationMs === 'number'
        ? detail.modelDurationMs
        : null;
      return {
        jobId: cleanText(detail.jobId),
        jobType: cleanText(detail.jobType),
        namespace: cleanText(detail.namespace),
        outcome: cleanText(row.action) === 'job_attempt_completed'
          ? 'completed' as const
          : 'failed' as const,
        attempt: Number(detail.attempt) || 0,
        maxAttempts: Number(detail.maxAttempts) || 0,
        failureClass: nullableText(detail.failureClass),
        resultStatus: nullableText(detail.resultStatus),
        compensationAction: nullableText(detail.compensationAction),
        recoveryStrategy: nullableText(detail.recoveryStrategy),
        noopReason: nullableText(detail.noopReason),
        retryable: typeof detail.retryable === 'boolean'
          ? detail.retryable
          : null,
        repeatedFingerprint:
          typeof detail.repeatedFingerprint === 'boolean'
            ? detail.repeatedFingerprint
            : null,
        nextState: cleanText(detail.nextState),
        modelDurationMs: modelDuration !== null && Number.isFinite(modelDuration)
          ? modelDuration
          : null,
        inputFingerprint: nullableText(detail.inputFingerprint),
        outputFingerprint: nullableText(detail.outputFingerprint),
        errorFingerprint: nullableText(detail.errorFingerprint),
        missingSourceIds,
        createdAt: cleanText(row.created_at),
      };
    });
    const unresolvedDeadLetterCount = deadLetters.filter(
      (item) => !item.resolved,
    ).length;
    const activeMemories = Number(index.active_memories);
    const ftsMemories = Number(index.fts_memories);
    const annMemories = Number(index.ann_memories);
    const termMemories = Number(index.term_memories);
    const dense = this.memoryStore.denseIndexWatermark(
      ownerId,
      config.defaultNamespace,
    );
    const denseAlias = this.memoryStore.denseIndexAlias(
      ownerId,
      config.defaultNamespace,
    );
    const denseGenerations =
      this.memoryStore.denseIndexGenerations(
        ownerId,
        config.defaultNamespace,
      );
    const generationRole = new Map<string, 'active' | 'building' | 'previous'>();
    if (denseAlias?.activeGenerationId) {
      generationRole.set(denseAlias.activeGenerationId, 'active');
    }
    if (denseAlias?.buildingGenerationId) {
      generationRole.set(denseAlias.buildingGenerationId, 'building');
    }
    if (denseAlias?.previousGenerationId) {
      generationRole.set(denseAlias.previousGenerationId, 'previous');
    }
    const denseGenerationStatus = denseGenerations.flatMap(
      (generation) => {
        const role = generationRole.get(generation.generationId);
        if (!role) return [];
        const evaluation =
          this.memoryStore.latestDenseIndexEvaluation(
            generation.generationId,
            ownerId,
          );
        return [{
          role,
          generationId: generation.generationId,
          modelId: generation.modelId,
          embeddingModel: generation.embeddingModel,
          indexVersion: generation.indexVersion,
          dimensions: generation.dimensions,
          generationKey: generation.generationKey,
          status: generation.status,
          readyAt: generation.readyAt,
          failureReason: generation.failureReason,
          evaluation: evaluation
            ? {
                evaluationId: evaluation.evaluationId,
                datasetId: evaluation.datasetId,
                datasetSha256: evaluation.datasetSha256,
                evaluatorVersion: evaluation.evaluatorVersion,
                queryCount: evaluation.queryCount,
                recallAt20: evaluation.recallAt20,
                mrrAt10: evaluation.mrrAt10,
                passed: evaluation.passed,
                completedAt: evaluation.completedAt,
              }
            : null,
        }];
      },
    );
    const activeDenseStatus = denseGenerationStatus.find(
      (generation) => generation.role === 'active',
    );
    const structuralLag = Math.max(
      activeMemories - Math.min(ftsMemories, termMemories),
      0,
    );
    const denseLag = Math.max(
      dense.eligible - dense.indexed,
      0,
    );
    const retrievalLog = this.memoryStore.retrievalLogHealth(ownerId);
    const lag = Math.max(structuralLag, denseLag);
    const models = {
      chat: input.chatModel ?? config.compatChatModel,
      query: config.queryModel,
      extraction: config.extractionModel,
      relation: config.relationModel,
      explicitIntent: config.explicitIntentModel,
      consolidation: config.consolidationModel,
      reflection: config.reflectionModel,
      embedding: config.embeddingModel,
      reranker: config.rerankModel,
    };
    const modelInventoryKnown = input.availableModels !== undefined;
    const availableModels = input.availableModels || [];
    const availableModelSet = new Set(availableModels);
    const missingModels = modelInventoryKnown
      ? [...new Set(Object.values(models))]
          .filter((model) => !availableModelSet.has(model))
      : [];
    const chatUnavailable =
      !input.ollamaAvailable ||
      (modelInventoryKnown &&
        !availableModelSet.has(models.chat));
    const quality =
      unresolvedDeadLetterCount > 0
        ? 'unavailable'
      : chatUnavailable
        ? 'unavailable'
        : missingModels.length > 0 && config.semanticMode === 'required'
          ? 'unavailable'
        : activeDenseStatus?.evaluation?.passed === false
          ? 'unavailable'
          : lag > 0 ||
              !input.ollamaAvailable ||
              Boolean(
                activeDenseStatus &&
                !activeDenseStatus.evaluation,
              )
          ? 'degraded'
          : retrievalLog.consecutiveFailures > 0
            ? 'degraded'
          : 'full';
    return {
      quality,
      ollamaAvailable: input.ollamaAvailable,
      availableModels,
      missingModels,
      modelRuntime: {
        ...modelRuntimeStatus(config.foregroundQuietMs),
        keepAlive: String(config.modelKeepAlive),
      },
      queues: queueRows.map((row) => ({
        jobType: cleanText(row.job_type),
        status: cleanText(row.status),
        count: Number(row.count),
        oldestAvailableAt: nullableText(row.oldest_available_at),
      })),
      deadLetterCount: unresolvedDeadLetterCount,
      deadLetterHistoryCount: deadLetters.length,
      deadLetters: deadLetters.slice(0, 20),
      jobAttempts,
      candidateCounts,
      index: {
        activeMemories,
        ftsMemories,
        annMemories,
        termMemories,
        embeddingMemories: Number(index.embedding_memories),
        denseEligible: dense.eligible,
        denseIndexed: dense.indexed,
        denseDimensions: dense.dimensions,
        denseIndexVersion: dense.indexVersion,
        lag,
      },
      denseIndex: {
        alias: denseAlias
          ? {
              activeGenerationId:
                denseAlias.activeGenerationId,
              buildingGenerationId:
                denseAlias.buildingGenerationId,
              previousGenerationId:
                denseAlias.previousGenerationId,
              revision: denseAlias.revision,
              updatedAt: denseAlias.updatedAt,
            }
          : null,
        generations: denseGenerationStatus,
      },
      automation: {
        averageExtractionLatencyMs:
          extraction.average_latency_ms === null
            ? null
            : Number(
                Number(extraction.average_latency_ms).toFixed(2),
              ),
        failedExtractionCount:
          Number(extraction.failed_count || 0),
        retryingJobCount:
          Number(automation.retrying_job_count),
        staleConsolidationCount:
          Number(automation.stale_count),
        quarantinedConsolidationCount:
          Number(automation.quarantined_count),
      },
      retrievalLog,
      models,
      timestamp: new Date().toISOString(),
    };
  }

  recoverDeadLetterJob(
    jobId: string,
    userId: string,
    namespace: string,
    mode: DeadLetterRecoveryMode,
    reason?: string,
  ): MemoryJob {
    return this.lifecycleStore.recoverDeadLetterJob(
      cleanText(jobId),
      cleanText(userId),
      cleanText(namespace),
      mode,
      cleanText(reason) || undefined,
    );
  }

  get lifecycle(): LifecycleStore {
    return this.lifecycleStore;
  }

  get memoryGovernance(): MemoryGovernance {
    return this.governance;
  }

  private recallResultDetails(
    value: unknown,
    userId: string,
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) return [];
    const evidence = this.database.prepare(
      `SELECT e.evidence_type, e.excerpt, e.source_ref, e.turn_id
       FROM memory_evidence e
       JOIN memory_versions v ON v.id = e.memory_version_id
       JOIN memory_items i ON i.id = v.memory_item_id
       WHERE e.memory_version_id = ? AND i.user_id = ?
       ORDER BY e.created_at ASC
       LIMIT 3`,
    );
    return value.flatMap((item) => {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item)
      ) {
        return [];
      }
      const detail = item as Record<string, unknown>;
      const versionId = nullableText(detail.versionId);
      const sources = versionId
        ? evidence.all(versionId, cleanText(userId)) as DatabaseRow[]
        : [];
      return [{
        ...detail,
        evidence: sources.map((row) => ({
          evidenceType: cleanText(row.evidence_type),
          excerpt:
            evidenceNullableText(row.excerpt)?.slice(0, 240) ||
            null,
          sourceRef: nullableText(row.source_ref),
          turnId: nullableText(row.turn_id),
        })),
      }];
    });
  }

  private consolidationDetail(
    memoryId: string,
    userId: string,
  ): Record<string, unknown> | null {
    const row = this.database
      .prepare(
        `SELECT *
         FROM derived_consolidations
         WHERE memory_id = ? AND user_id = ?`,
      )
      .get(
        cleanText(memoryId),
        cleanText(userId),
      ) as DatabaseRow | undefined;
    if (!row) return null;
    const consolidationId = cleanText(row.id);
    const sentenceRows = this.database
      .prepare(
        `SELECT *
         FROM derived_consolidation_sentences
         WHERE consolidation_id = ?
         ORDER BY sentence_index ASC`,
      )
      .all(consolidationId) as DatabaseRow[];
    return {
      id: consolidationId,
      scopeType: cleanText(row.scope_type),
      scopeKey: cleanText(row.scope_key),
      sourceSetHash: cleanText(row.source_set_hash),
      model: cleanText(row.model),
      promptVersion: cleanText(row.prompt_version),
      status: cleanText(row.status),
      generatedAt: cleanText(row.generated_at),
      staleAt: nullableText(row.stale_at),
      sentences: sentenceRows.map((sentence) => {
        const sentenceId = cleanText(sentence.id);
        const sources = this.database
          .prepare(
            `SELECT memory_version_id
             FROM derived_sentence_sources
             WHERE sentence_id = ?
             ORDER BY memory_version_id ASC`,
          )
          .all(sentenceId) as DatabaseRow[];
        return {
          id: sentenceId,
          index: Number(sentence.sentence_index),
          text: cleanText(sentence.sentence_text),
          supported: Number(sentence.supported) === 1,
          sourceVersionIds: sources.map(
            (source) => cleanText(source.memory_version_id),
          ),
        };
      }),
    };
  }
}
