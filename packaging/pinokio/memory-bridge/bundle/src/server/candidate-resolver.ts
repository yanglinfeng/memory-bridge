import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ClaimRelationEngine,
  canonicalStableKey,
  classifyPredicateCardinality,
  rowToCanonicalTarget,
  strongerAuthority,
  type CanonicalClaimTarget,
  type ClaimEmbeddingProvider,
  type ClaimRelationClassifier,
  type ClaimRelationAssessment,
  type ClaimRelationDecision,
  type ClaimRelationTarget,
  type ClaimSubject,
} from './claim-relation-engine.js';
import {
  LifecycleStore,
  type CandidateRelation,
  type CandidateResolutionAudit,
  type CandidateResolutionMethod,
  type MemoryCandidate,
} from './lifecycle-store.js';
import { MemoryStore } from './memory-store.js';
import {
  findBlockingTombstone,
  tombstoneIdentityFields,
} from './tombstone-policy.js';
import {
  alignSourceExcerpt,
  deterministicAtomicCandidateContent,
  isAtomicCandidateContentSupported,
  structuredAtomicCandidateText,
} from './memory-extractor.js';
import type {
  MemoryAccessScope,
  PredicateCardinality,
} from './types.js';

export {
  classifyPredicateCardinality,
} from './claim-relation-engine.js';
export type {
  ClaimEmbeddingProvider,
  ClaimRelationClassifier,
  ClaimRelationDecision,
  ClaimRelationTarget,
} from './claim-relation-engine.js';

type DatabaseRow = Record<string, unknown>;

export type AutomationMode = 'off' | 'shadow' | 'auto';

export interface CandidateResolverOptions {
  mode: AutomationMode;
  autoCommitMinConfidence?: number;
  autoCommitMinImportance?: number;
  classifier?: ClaimRelationClassifier;
  embeddingProvider?: ClaimEmbeddingProvider;
  embeddingNearThreshold?: number;
}

export interface CandidateClaimAssessmentOptions {
  excludeMemoryIds?: string[];
  cardinality?: PredicateCardinality;
}

export interface CandidateResolutionResult {
  candidateId: string;
  state: MemoryCandidate['state'];
  reason: string;
  memoryId: string | null;
  relation: CandidateRelation | null;
  method: CandidateResolutionMethod | null;
}

export interface CandidateReviewInput {
  content?: string;
  value?: string;
  blockFuture?: boolean;
  context?: string;
}

type CanonicalItem = CanonicalClaimTarget;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function cleanText(value: unknown): string {
  return asText(value).normalize('NFKC').trim();
}

function normalizePart(value: unknown): string {
  return cleanText(value).toLocaleLowerCase('zh-CN');
}

function correctionContent(
  predicateKey: string,
  value: string,
  fallback: string,
): string {
  const parts = predicateKey
    .split('::')
    .map((part) => cleanText(part))
    .filter(Boolean);
  if (parts.length < 2) return fallback;
  const subject = parts.shift()!;
  const predicate = parts.join('::');
  const normalizedValue = cleanText(value).replace(
    /[。.!！]+$/u,
    '',
  );
  return `${subject}的${predicate}是${normalizedValue}。`;
}

function contextualCorrectionContent(
  context: string,
  previousValue: string | null,
  value: string,
  negated: boolean,
  fallback: string,
): string {
  const normalizedPrevious = cleanText(previousValue);
  const subject = cleanText(context)
    .replace(normalizedPrevious, ' ')
    .replace(/[\s:：,，;；|/。.!！?？]+/gu, ' ')
    .replace(/(?:应该|应当|必须|需要|改为|更新为)$/u, '')
    .trim();
  if (!subject || subject.length > 200) return fallback;
  return deterministicAtomicCandidateContent({
    subject,
    predicate: '当前值',
    value,
    content: '',
    negated,
  }) || fallback;
}

function scopeIsAuthorized(
  scopeType: string,
  scopeKey: string,
  authorizedScopes: MemoryAccessScope[],
): boolean {
  return authorizedScopes.some(
    (scope) =>
      scope.scopeType === scopeType && scope.scopeKey === scopeKey,
  );
}

function isVerifiedStablePatternInference(
  database: DatabaseSync,
  candidate: MemoryCandidate,
): boolean {
  if (
    candidate.sourceAuthority !== 'assistant_inference' ||
    candidate.candidateOrigin !== 'reflection' ||
    candidate.decisionReason !== 'verified_stable_pattern' ||
    candidate.sensitivity !== 'normal' ||
    candidate.negated ||
    !candidate.claimFingerprint
  ) return false;
  const row = database.prepare(
    `SELECT COUNT(DISTINCT e.turn_id) AS evidence_count,
            COUNT(DISTINCT substr(t.occurred_at, 1, 10)) AS evidence_days
     FROM memory_candidate_evidence e
     JOIN conversation_turns t ON t.id = e.turn_id
     WHERE e.candidate_id = ? AND e.evidence_type = 'pattern_support'
       AND e.user_id = ? AND e.namespace = ?
       AND e.scope_type = ? AND e.scope_key = ?
       AND t.user_id = e.user_id AND t.namespace = e.namespace
       AND t.role = 'user' AND instr(t.content, e.excerpt) > 0
       AND EXISTS (
         SELECT 1 FROM memory_reflection_claims c
         WHERE c.user_id = e.user_id AND c.namespace = e.namespace
           AND c.scope_type = e.scope_type AND c.scope_key = e.scope_key
           AND c.claim_fingerprint = ? AND c.candidate_id = e.candidate_id
           AND c.decision = 'active'
       )`,
  ).get(
    candidate.id,
    candidate.userId,
    candidate.namespace,
    candidate.scopeType,
    candidate.scopeKey,
    candidate.claimFingerprint,
  ) as DatabaseRow | undefined;
  return Number(row?.evidence_count || 0) >= 3 &&
    Number(row?.evidence_days || 0) >= 2;
}


export class CandidateResolver {
  private readonly mode: AutomationMode;
  private readonly minConfidence: number;
  private readonly minImportance: number;
  private readonly relationEngine: ClaimRelationEngine;

  constructor(
    private readonly database: DatabaseSync,
    private readonly lifecycleStore: LifecycleStore,
    private readonly memoryStore: MemoryStore,
    options: CandidateResolverOptions,
  ) {
    this.mode = options.mode;
    this.minConfidence = clamp(
      options.autoCommitMinConfidence ?? 0.95,
    );
    this.minImportance = clamp(
      options.autoCommitMinImportance ?? 0.5,
    );
    this.relationEngine = new ClaimRelationEngine({
      classifier: options.classifier,
      embeddingProvider: options.embeddingProvider,
      embeddingNearThreshold: options.embeddingNearThreshold,
    });
  }

  assessClaim(
    candidate: ClaimSubject,
    options: CandidateClaimAssessmentOptions = {},
  ): Promise<ClaimRelationAssessment> {
    const excluded = new Set(options.excludeMemoryIds || []);
    const cardinality = options.cardinality || classifyPredicateCardinality(
      candidate.kind,
      candidate.predicate,
    );
    const stableKey = canonicalStableKey(candidate, cardinality);
    const predicateTargets = this.findCanonicalItems(
      candidate,
      true,
      stableKey,
    ).filter((item) => !excluded.has(item.id));
    const semanticTargets = this.findCanonicalItems(
      candidate,
      false,
      stableKey,
    ).filter((item) => !excluded.has(item.id));
    return this.relationEngine.assess(candidate, {
      cardinality,
      predicateTargets,
      semanticTargets,
    });
  }

  async resolve(
    candidateId: string,
  ): Promise<CandidateResolutionResult> {
    const candidate = this.lifecycleStore.getCandidate(candidateId);
    if (!candidate) throw new Error('候选记忆不存在');
    if (candidate.state !== 'pending') {
      return this.existingResult(candidate);
    }

    if (candidate.sensitivity === 'credential') {
      return this.decide(
        candidate,
        'rejected',
        'credential_blocked',
      );
    }
    const verifiedStablePattern = isVerifiedStablePatternInference(
      this.database,
      candidate,
    );
    if (
      candidate.sourceAuthority === 'assistant_inference' &&
      !verifiedStablePattern
    ) {
      return this.decide(
        candidate,
        'pending',
        'assistant_inference_requires_confirmation',
      );
    }
    if (this.mode === 'off') {
      return this.decide(candidate, 'pending', 'automation_off');
    }
    if (this.mode === 'shadow') {
      return this.decide(candidate, 'pending', 'shadow_mode');
    }
    const sourceExcerpt = asText(
      candidate.sourceExcerpt,
    ).trim();
    if (
      !verifiedStablePattern &&
      !isAtomicCandidateContentSupported({
        subject: candidate.subject,
        predicate: candidate.predicate,
        value: candidate.value,
        content: candidate.content,
        sourceExcerpt,
        negated: candidate.negated,
      })
    ) {
      return this.decide(
        candidate,
        'pending',
        'candidate_content_unsupported',
      );
    }
    const sourceTurn = candidate.turnId
      ? this.lifecycleStore.getTurn(candidate.turnId)
      : null;
    if (
      !verifiedStablePattern && (
        !sourceExcerpt ||
        !sourceTurn ||
        alignSourceExcerpt(sourceTurn.content, {
          content: structuredAtomicCandidateText(candidate),
          value: candidate.value,
          sourceExcerpt,
        }) !== sourceExcerpt
      )
    ) {
      return this.decide(
        candidate,
        'pending',
        'source_evidence_required',
      );
    }
    if (candidate.sensitivity !== 'normal') {
      return this.decide(
        candidate,
        'pending',
        'sensitive_requires_confirmation',
      );
    }
    if (candidate.confidence < this.minConfidence) {
      return this.decide(
        candidate,
        'pending',
        'confidence_below_auto_commit_threshold',
      );
    }
    if (candidate.importance < this.minImportance) {
      return this.decide(
        candidate,
        'pending',
        'importance_below_auto_commit_threshold',
      );
    }

    const cardinality = classifyPredicateCardinality(
      candidate.kind,
      candidate.predicate,
    );
    const stableKey = canonicalStableKey(candidate, cardinality);
    if (
      this.isTombstoned(
        candidate,
        stableKey,
      )
    ) {
      return this.decide(
        candidate,
        'rejected',
        'tombstone_blocked',
      );
    }
    const canonicalIdentity = this.inspectCanonicalIdentity(
      candidate,
      stableKey,
      cardinality,
    );
    if (canonicalIdentity.incompatibility) {
      return this.decide(
        candidate,
        'conflicted',
        'canonical_identity_incompatible',
        undefined,
        this.audit(
          'contradicts',
          'rule',
          1,
          canonicalIdentity.incompatibility,
        ),
      );
    }

    const assessment = await this.assessClaim(candidate, { cardinality });
    if (
      candidate.explicitCorrection &&
      cardinality === 'single' &&
      assessment.readSet === 'predicate' &&
      assessment.relatedTargets.length > 1
    ) {
      return this.decide(
        candidate,
        'conflicted',
        'explicit_correction_target_ambiguous',
        undefined,
        this.audit(
          'contradicts',
          'rule',
          1,
          '显式纠正匹配多个同作用域、同谓词目标，拒绝猜测',
        ),
      );
    }
    if (this.isTombstoned(candidate, assessment.stableKey)) {
      return this.decide(
        candidate,
        'rejected',
        'tombstone_blocked',
      );
    }
    return this.applyAssessment(candidate, assessment);
  }

  acceptForReview(
    candidateId: string,
    input: CandidateReviewInput = {},
  ): CandidateResolutionResult {
    const original = this.lifecycleStore.getCandidate(candidateId);
    if (!original) throw new Error('候选记忆不存在');
    if (original.state === 'accepted') {
      return this.existingResult(original);
    }
    if (
      original.state !== 'pending' &&
      original.state !== 'conflicted'
    ) {
      throw new Error('只有待确认或冲突候选可以接受');
    }
    if (original.sensitivity === 'credential') {
      throw new Error('凭据候选不能被接受');
    }
    const value = cleanText(input.value) || original.value;
    const content = cleanText(input.content) || original.content;
    const candidate: MemoryCandidate = {
      ...original,
      value,
      content,
      sourceAuthority: 'user_confirmed',
      normalizedHash: sha256(
        `${original.stableKey}\n` +
        `${original.negated ? 'negated' : 'affirmed'}\n` +
        normalizePart(value),
      ),
    };
    const cardinality = classifyPredicateCardinality(
      candidate.kind,
      candidate.predicate,
    );
    const stableKey = canonicalStableKey(candidate, cardinality);
    if (this.isTombstoned(candidate, stableKey)) {
      throw new Error('该候选已被“以后不要再记”规则阻止');
    }
    const canonicalIdentity = this.inspectCanonicalIdentity(
      candidate,
      stableKey,
      cardinality,
    );
    if (canonicalIdentity.incompatibility) {
      throw new Error('规范记忆身份不兼容，不能直接接受');
    }
    const predicateItems = this.findCanonicalItems(
      candidate,
      true,
      stableKey,
    );
    const exact = predicateItems.find(
      (item) =>
        item.normalizedValueHash === candidate.normalizedHash,
    );
    if (exact) {
      return normalizePart(exact.content) === normalizePart(content)
        ? this.observeEquivalent(
            candidate,
            exact,
            this.audit(
              'equivalent',
              'manual',
              1,
              '人工确认等价观察',
              exact.id,
            ),
            'manual_review_equivalent',
          )
        : this.reinforce(
            candidate,
            exact,
            cardinality,
            this.audit(
              'reinforces',
              'manual',
              1,
              '人工确认新增强化证据',
              exact.id,
            ),
            'manual_review_reinforced',
          );
    }
    if (cardinality === 'single' && predicateItems.length > 0) {
      return this.correct(
        candidate,
        predicateItems[0],
        cardinality,
        this.audit(
          'supersedes',
          'manual',
          1,
          '人工确认替代当前事实',
          predicateItems[0].id,
        ),
        'manual_review_corrected',
      );
    }
    return this.create(
      candidate,
      cardinality,
      stableKey,
      this.audit(
        'coexists',
        'manual',
        1,
        '人工确认创建并存事实',
      ),
      'manual_review_accepted',
    );
  }

  acceptCorrectionForReview(
    candidateId: string,
    targetMemoryId: string,
    authorizedScopes: MemoryAccessScope[],
    input: CandidateReviewInput = {},
    method: CandidateResolutionMethod = 'manual',
  ): CandidateResolutionResult {
    const original = this.lifecycleStore.getCandidate(candidateId);
    if (!original) throw new Error('候选记忆不存在');
    if (original.state === 'accepted') {
      if (
        original.resolvedMemoryItemId &&
        original.resolvedMemoryItemId !== targetMemoryId
      ) {
        throw new Error('候选记忆已经纠正了另一个目标');
      }
      return this.existingResult(original);
    }
    if (
      original.state !== 'pending' &&
      original.state !== 'conflicted'
    ) {
      throw new Error('只有待确认或冲突候选可以接受');
    }
    if (original.sensitivity === 'credential') {
      throw new Error('凭据候选不能被接受');
    }
    const row = this.database
      .prepare(
        `SELECT
           i.id,
           i.revision,
           i.status AS item_status,
           i.updated_at AS item_updated_at,
           i.user_id AS item_user_id,
           i.namespace AS item_namespace,
           i.kind AS item_kind,
           i.scope_type AS item_scope_type,
           i.scope_key AS item_scope_key,
           i.stable_key,
           i.predicate_key,
           i.normalized_value_hash,
           i.normalized_value,
           i.observation_count,
           i.predicate_cardinality,
           m.kind,
           m.user_id AS memory_user_id,
           m.namespace AS memory_namespace,
           m.confidence,
           m.importance,
           m.content,
           m.status AS memory_status,
           m.updated_at AS memory_updated_at,
           m.checksum,
           m.sensitivity,
           m.source_authority,
           m.scope_type,
           m.scope_key,
           m.occurred_at,
           m.valid_from,
           m.valid_to
         FROM memory_items i
         JOIN memories m ON m.id = i.id
         WHERE i.id = ?
           AND i.user_id = ?
           AND i.namespace = ?
           AND i.status = 'active'
           AND m.status = 'active'`,
      )
      .get(
        targetMemoryId,
        original.userId,
        original.namespace,
      ) as DatabaseRow | undefined;
    if (!row) {
      throw new Error('纠正目标不存在、已失效或不属于当前命名空间');
    }
    const targetScopeType = asText(row.scope_type);
    const targetScopeKey = asText(row.scope_key);
    const canonicalProjectionConsistent =
      asText(row.item_user_id) === original.userId &&
      asText(row.memory_user_id) === original.userId &&
      asText(row.item_namespace) === original.namespace &&
      asText(row.memory_namespace) === original.namespace &&
      asText(row.item_kind) === asText(row.kind) &&
      asText(row.item_scope_type) === targetScopeType &&
      asText(row.item_scope_key) === targetScopeKey;
    if (!canonicalProjectionConsistent) {
      throw new Error('纠正目标状态或规范投影不一致');
    }
    if (!scopeIsAuthorized(
      targetScopeType,
      targetScopeKey,
      authorizedScopes,
    )) {
      throw new Error('纠正目标对原会话不可见');
    }
    const target = rowToCanonicalTarget(row);
    const value = cleanText(input.value) || original.value;
    const canonicalFallback = correctionContent(
      target.predicateKey,
      value,
      original.content,
    );
    const content = method === 'rule'
      ? contextualCorrectionContent(
          cleanText(input.context),
          target.normalizedValue,
          value,
          original.negated,
          canonicalFallback,
        )
      : cleanText(input.content) || canonicalFallback;
    const candidate: MemoryCandidate = {
      ...original,
      kind: asText(row.kind) as MemoryCandidate['kind'],
      value,
      content,
      normalizedKey: target.predicateKey,
      stableKey: target.stableKey,
      normalizedHash: sha256(
        `${target.stableKey}\n` +
        `${original.negated ? 'negated' : 'affirmed'}\n` +
        normalizePart(value),
      ),
      scopeType: target.scopeType,
      scopeKey: target.scopeKey,
      sourceAuthority:
        method === 'manual'
          ? 'user_confirmed'
          : original.sourceAuthority,
      explicitCorrection: true,
    };
    if (this.isTombstoned(candidate, target.stableKey)) {
      throw new Error('该纠正值已被“以后不要再记”规则阻止');
    }
    const storedCardinality = asText(row.predicate_cardinality);
    const cardinality: PredicateCardinality =
      storedCardinality === 'set' || storedCardinality === 'event'
        ? storedCardinality
        : 'single';
    return this.correct(
      candidate,
      target,
      cardinality,
      this.audit(
        'supersedes',
        method,
        1,
        method === 'manual'
          ? '人工确认纠正唯一目标'
          : '显式纠正锁定唯一目标',
        target.id,
      ),
      method === 'manual'
        ? 'manual_review_corrected'
        : 'explicit_targeted_correction',
    );
  }

  rejectForReview(
    candidateId: string,
    blockFuture = false,
  ): CandidateResolutionResult {
    const candidate = this.lifecycleStore.getCandidate(candidateId);
    if (!candidate) throw new Error('候选记忆不存在');
    if (
      candidate.state !== 'pending' &&
      candidate.state !== 'conflicted' &&
      candidate.state !== 'rejected'
    ) {
      throw new Error('只有待确认或冲突候选可以拒绝');
    }
    const updated = this.lifecycleStore.updateCandidateState(
      candidate.id,
      'rejected',
      blockFuture
        ? 'manual_rejected_and_tombstoned'
        : 'manual_rejected',
      candidate.resolvedMemoryItemId || undefined,
      true,
      undefined,
      blockFuture
        ? (current, timestamp) => {
            const cardinality = classifyPredicateCardinality(
              current.kind,
              current.predicate,
            );
            const stableKey = canonicalStableKey(
              current,
              cardinality,
            );
            const identity = tombstoneIdentityFields({
              kind: current.kind,
              content: current.content,
              stableKey,
              normalizedKey: current.normalizedKey,
              normalizedValue: current.value,
              scopeType: current.scopeType,
              scopeKey: current.scopeKey,
            });
            this.database.prepare(
              `INSERT INTO memory_tombstones (
                 id, user_id, namespace, stable_key, content_hash, reason,
                 created_at, scope_type, scope_key, kind, normalized_key,
                 normalized_value, semantic_fingerprint
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO NOTHING`,
            ).run(
              randomUUID(),
              current.userId,
              current.namespace,
              stableKey,
              identity.contentHash,
              'manual_do_not_remember',
              timestamp,
              current.scopeType,
              current.scopeKey,
              identity.kind,
              identity.normalizedKey,
              identity.normalizedValue,
              identity.semanticFingerprint,
            );
          }
        : undefined,
    );
    return {
      candidateId: updated.id,
      state: updated.state,
      reason:
        updated.decisionReason ||
        (blockFuture
          ? 'manual_rejected_and_tombstoned'
          : 'manual_rejected'),
      memoryId: updated.resolvedMemoryItemId,
      relation: null,
      method: null,
    };
  }

  private applyAssessment(
    candidate: MemoryCandidate,
    assessment: ClaimRelationAssessment,
  ): CandidateResolutionResult {
    const target = assessment.target as CanonicalItem | null;
    const audit = this.audit(
      assessment.relation,
      assessment.method,
      assessment.confidence,
      assessment.rationale,
      target?.id,
      assessment.model || undefined,
      assessment.promptVersion || undefined,
    );
    if (assessment.relation === 'equivalent') {
      if (!target) throw new Error('等价关系缺少目标记忆');
      return this.observeEquivalent(
        candidate,
        target,
        audit,
        assessment.reason,
      );
    }
    if (assessment.relation === 'reinforces') {
      if (!target) throw new Error('强化关系缺少目标记忆');
      return this.reinforce(
        candidate,
        target,
        assessment.cardinality,
        audit,
        assessment.reason,
      );
    }
    if (assessment.relation === 'supersedes') {
      if (!target) throw new Error('替代关系缺少目标记忆');
      return this.correct(
        candidate,
        target,
        assessment.cardinality,
        audit,
        assessment.reason,
      );
    }
    if (assessment.relation === 'contradicts') {
      if (!target) throw new Error('冲突关系缺少目标记忆');
      return this.decide(
        candidate,
        'conflicted',
        assessment.reason,
        target.id,
        audit,
      );
    }
    return this.create(
      candidate,
      assessment.cardinality,
      assessment.stableKey,
      audit,
      assessment.reason,
    );
  }

  private create(
    candidate: MemoryCandidate,
    cardinality: PredicateCardinality,
    stableKey: string,
    audit: CandidateResolutionAudit,
    reason: string,
  ): CandidateResolutionResult {
    const canonicalIdentity = this.inspectCanonicalIdentity(
      candidate,
      stableKey,
      cardinality,
    );
    if (canonicalIdentity.exists) {
      return this.decide(
        candidate,
        'conflicted',
        canonicalIdentity.incompatibility
          ? 'canonical_identity_incompatible'
          : 'canonical_identity_changed_during_resolution',
        undefined,
        this.audit(
          'contradicts',
          'rule',
          1,
          canonicalIdentity.incompatibility ||
            '规范记忆在关系评估后出现，拒绝重复创建',
        ),
      );
    }
    return this.acceptAtomically(
      candidate,
      stableKey,
      reason,
      audit,
      () => this.memoryStore.remember({
        userId: candidate.userId,
        namespace: candidate.namespace,
        kind: candidate.kind,
        content: candidate.content,
        importance: candidate.importance,
        confidence: candidate.confidence,
        source: 'lifecycle-auto',
        sourceRef: `candidate:${candidate.id}`,
        idempotencyKey: `candidate:${candidate.id}`,
        stableKey,
        predicateKey: candidate.normalizedKey,
        normalizedValueHash: candidate.normalizedHash,
        normalizedValue: candidate.value,
        predicateCardinality: cardinality,
        evidenceTurnId: candidate.turnId || undefined,
        evidenceExcerpt: candidate.sourceExcerpt || undefined,
        createdBy: 'candidate-resolver',
        scopeType: candidate.scopeType,
        scopeKey: candidate.scopeKey,
        sensitivity: candidate.sensitivity,
        sourceAuthority: candidate.sourceAuthority,
        negated: candidate.negated,
        occurredAt: candidate.claimOccurredAt || undefined,
        validFrom: candidate.claimValidFrom || undefined,
        validTo: candidate.claimValidTo || undefined,
      }).memory,
    );
  }

  private observeEquivalent(
    candidate: MemoryCandidate,
    current: CanonicalItem,
    audit: CandidateResolutionAudit,
    reason = 'equivalent_observation',
  ): CandidateResolutionResult {
    return this.acceptAtomically(
      candidate,
      current.stableKey,
      reason,
      audit,
      () => this.memoryStore.observe(
        current.id,
        {
          expectedRevision: current.revision,
          evidenceTurnId: candidate.turnId || undefined,
          evidenceExcerpt: candidate.sourceExcerpt || undefined,
          sourceRef: `candidate:${candidate.id}`,
          sensitivity: candidate.sensitivity,
          sourceAuthority: candidate.sourceAuthority,
          idempotencyKey: `candidate:${candidate.id}`,
        },
        candidate.userId,
      ),
    );
  }

  private reinforce(
    candidate: MemoryCandidate,
    current: CanonicalItem,
    cardinality: PredicateCardinality,
    audit: CandidateResolutionAudit,
    reason = 'equivalent_value_reinforced',
  ): CandidateResolutionResult {
    const observationCount = Math.max(1, current.observationCount);
    const confidence = Number(
      (
        (
          current.confidence * observationCount +
          candidate.confidence
        ) /
        (observationCount + 1)
      ).toFixed(4),
    );
    return this.acceptAtomically(
      candidate,
      current.stableKey,
      reason,
      audit,
      () => this.memoryStore.update(
        current.id,
        {
          content: current.content,
          confidence,
          importance: Math.max(
            current.importance,
            candidate.importance,
          ),
          sourceRef: `candidate:${candidate.id}`,
          evidenceTurnId: candidate.turnId || undefined,
          evidenceExcerpt: candidate.sourceExcerpt || undefined,
          createdBy: 'candidate-resolver',
          idempotencyKey: `candidate:${candidate.id}`,
          expectedRevision: current.revision,
          resolutionType: 'reinforcement',
          predicateKey: candidate.normalizedKey,
          normalizedValueHash: candidate.normalizedHash,
          normalizedValue: candidate.value,
          predicateCardinality: cardinality,
          scopeType: candidate.scopeType,
          scopeKey: candidate.scopeKey,
          sensitivity:
            current.sensitivity === 'sensitive'
              ? 'sensitive'
              : candidate.sensitivity,
          sourceAuthority: strongerAuthority(
            current.sourceAuthority,
            candidate.sourceAuthority,
          ),
          negated: candidate.negated,
        },
        candidate.userId,
      ),
    );
  }

  private correct(
    candidate: MemoryCandidate,
    current: CanonicalItem,
    cardinality: PredicateCardinality,
    audit: CandidateResolutionAudit,
    reason = 'explicit_correction',
  ): CandidateResolutionResult {
    return this.acceptAtomically(
      candidate,
      current.stableKey,
      reason,
      audit,
      () => this.memoryStore.update(
        current.id,
        {
          content: candidate.content,
          confidence: candidate.confidence,
          importance: Math.max(
            current.importance,
            candidate.importance,
          ),
          source: 'lifecycle-auto',
          sourceRef: `candidate:${candidate.id}`,
          evidenceTurnId: candidate.turnId || undefined,
          evidenceExcerpt: candidate.sourceExcerpt || undefined,
          createdBy: 'candidate-resolver',
          idempotencyKey: `candidate:${candidate.id}`,
          expectedRevision: current.revision,
          closePreviousVersion: true,
          resolutionType: 'correction',
          predicateKey: candidate.normalizedKey,
          normalizedValueHash: candidate.normalizedHash,
          normalizedValue: candidate.value,
          predicateCardinality: cardinality,
          scopeType: candidate.scopeType,
          scopeKey: candidate.scopeKey,
          sensitivity: candidate.sensitivity,
          sourceAuthority: candidate.sourceAuthority,
          negated: candidate.negated,
          occurredAt: candidate.claimOccurredAt,
          validFrom: candidate.claimValidFrom,
          validTo: candidate.claimValidTo,
        },
        candidate.userId,
      ),
    );
  }

  private acceptAtomically(
    candidate: MemoryCandidate,
    stableKey: string,
    reason: string,
    audit: CandidateResolutionAudit,
    writeMemory: () => { id: string },
  ): CandidateResolutionResult {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) {
      this.database.exec('BEGIN IMMEDIATE');
    }
    try {
      if (this.isTombstoned(candidate, stableKey)) {
        throw new Error('该候选已被“以后不要再记”规则阻止');
      }
      const memory = writeMemory();
      const result = this.decide(
        candidate,
        'accepted',
        reason,
        memory.id,
        { ...audit, targetMemoryItemId: memory.id },
      );
      if (ownsTransaction) {
        this.database.exec('COMMIT');
      }
      return result;
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  private decide(
    candidate: MemoryCandidate,
    state: MemoryCandidate['state'],
    reason: string,
    memoryId?: string,
    resolution?: CandidateResolutionAudit,
  ): CandidateResolutionResult {
    const updated = this.lifecycleStore.updateCandidateState(
      candidate.id,
      state,
      reason,
      memoryId,
      candidate.state === 'conflicted' ||
        reason.startsWith('manual_'),
      resolution,
    );
    return {
      candidateId: updated.id,
      state: updated.state,
      reason: updated.decisionReason || reason,
      memoryId: updated.resolvedMemoryItemId,
      relation: resolution?.relation || null,
      method: resolution?.method || null,
    };
  }

  private existingResult(
    candidate: MemoryCandidate,
  ): CandidateResolutionResult {
    const run = this.database
      .prepare(
        `SELECT relation, method
         FROM candidate_resolution_runs
         WHERE candidate_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(candidate.id) as DatabaseRow | undefined;
    return {
      candidateId: candidate.id,
      state: candidate.state,
      reason: candidate.decisionReason || 'already_resolved',
      memoryId: candidate.resolvedMemoryItemId,
      relation: run
        ? asText(run.relation) as CandidateRelation
        : null,
      method: run
        ? asText(run.method) as CandidateResolutionMethod
        : null,
    };
  }

  private findCanonicalItems(
    candidate: ClaimSubject,
    samePredicateOnly: boolean,
    stableKey = canonicalStableKey(
      candidate,
      classifyPredicateCardinality(candidate.kind, candidate.predicate),
    ),
  ): CanonicalItem[] {
    const allowExplicitSinglePredicateDrift =
      samePredicateOnly &&
      candidate.explicitCorrection &&
      classifyPredicateCardinality(
        candidate.kind,
        candidate.predicate,
      ) === 'single';
    const rows = this.database
      .prepare(
        `SELECT
           i.id,
           i.revision,
           i.status AS item_status,
           i.updated_at AS item_updated_at,
           i.stable_key,
           i.predicate_key,
           i.normalized_value_hash,
           i.normalized_value,
           i.observation_count,
           m.confidence,
           m.importance,
           m.content,
           m.status AS memory_status,
           m.updated_at AS memory_updated_at,
           m.checksum,
           m.sensitivity,
           m.source_authority,
           m.scope_type,
           m.scope_key,
           m.occurred_at,
           m.valid_from,
           m.valid_to
         FROM memory_items i
         JOIN memories m ON m.id = i.id
         WHERE i.user_id = ?
           AND i.namespace = ?
           AND i.scope_type = ?
           AND i.scope_key = ?
           AND i.status = 'active'
           AND m.status = 'active'
           ${
             allowExplicitSinglePredicateDrift
               ? `AND i.predicate_key = ?
                  AND m.user_id = i.user_id
                  AND m.namespace = i.namespace
                  AND m.kind = i.kind
                  AND m.scope_type = i.scope_type
                  AND m.scope_key = i.scope_key`
               : `AND (m.kind = ? OR i.stable_key = ?)
                  ${samePredicateOnly
                    ? 'AND i.predicate_key = ?'
                    : ''}`
           }`,
      )
      .all(
        candidate.userId,
        candidate.namespace,
        candidate.scopeType,
        candidate.scopeKey,
        ...(allowExplicitSinglePredicateDrift
          ? [candidate.normalizedKey]
          : [
              candidate.kind,
              stableKey,
              ...(samePredicateOnly
                ? [candidate.normalizedKey]
                : []),
            ]),
      ) as DatabaseRow[];
    const items = rows.map(rowToCanonicalTarget);
    return samePredicateOnly
      ? items.sort(
          (left, right) =>
            right.itemUpdatedAt.localeCompare(left.itemUpdatedAt) ||
            left.id.localeCompare(right.id),
        )
      : items;
  }

  private inspectCanonicalIdentity(
    candidate: ClaimSubject,
    stableKey: string,
    cardinality: PredicateCardinality,
  ): { exists: boolean; incompatibility: string | null } {
    const row = this.database.prepare(
      `SELECT
         i.id,
         i.user_id AS item_user_id,
         i.namespace AS item_namespace,
         i.kind AS item_kind,
         i.status AS item_status,
         i.scope_type AS item_scope_type,
         i.scope_key AS item_scope_key,
         i.predicate_key,
         i.predicate_cardinality,
         m.id AS memory_id,
         m.user_id AS memory_user_id,
         m.namespace AS memory_namespace,
         m.kind AS memory_kind,
         m.status AS memory_status,
         m.scope_type AS memory_scope_type,
         m.scope_key AS memory_scope_key
       FROM memory_items i
       LEFT JOIN memories m ON m.id = i.id
       WHERE i.user_id = ? AND i.namespace = ? AND i.stable_key = ?`,
    ).get(
      candidate.userId,
      candidate.namespace,
      stableKey,
    ) as DatabaseRow | undefined;
    if (!row) return { exists: false, incompatibility: null };
    const itemStatus = asText(row.item_status);
    const memoryStatus = asText(row.memory_status);
    if (itemStatus === 'deleted' && memoryStatus === 'deleted') {
      return { exists: false, incompatibility: null };
    }
    const projectionConsistent =
      asText(row.memory_id) === asText(row.id) &&
      asText(row.item_user_id) === candidate.userId &&
      asText(row.memory_user_id) === candidate.userId &&
      asText(row.item_namespace) === candidate.namespace &&
      asText(row.memory_namespace) === candidate.namespace &&
      asText(row.item_kind) === asText(row.memory_kind) &&
      asText(row.item_scope_type) === asText(row.memory_scope_type) &&
      asText(row.item_scope_key) === asText(row.memory_scope_key) &&
      itemStatus === 'active' &&
      memoryStatus === 'active';
    if (!projectionConsistent) {
      return {
        exists: true,
        incompatibility: '同 stable_key 的规范投影不一致或不是活动状态',
      };
    }
    if (
      asText(row.item_scope_type) !== candidate.scopeType ||
      asText(row.item_scope_key) !== candidate.scopeKey
    ) {
      return {
        exists: true,
        incompatibility: '同 stable_key 的规范记忆属于不同 scope',
      };
    }
    if (asText(row.predicate_key) !== candidate.normalizedKey) {
      return {
        exists: true,
        incompatibility: '同 stable_key 的规范记忆具有不同 predicate_key',
      };
    }
    if (asText(row.predicate_cardinality) !== cardinality) {
      return {
        exists: true,
        incompatibility: '同 stable_key 的规范记忆具有不兼容 cardinality',
      };
    }
    return { exists: true, incompatibility: null };
  }

  private isTombstoned(
    candidate: MemoryCandidate,
    stableKey: string,
  ): boolean {
    return findBlockingTombstone(this.database, {
      userId: candidate.userId,
      namespace: candidate.namespace,
      scopeType: candidate.scopeType,
      scopeKey: candidate.scopeKey,
      kind: candidate.kind,
      content: candidate.content,
      stableKey,
      normalizedKey: candidate.normalizedKey,
      normalizedValue: candidate.value,
    }) !== null;
  }

  private audit(
    relation: CandidateRelation,
    method: CandidateResolutionMethod,
    confidence: number,
    rationale: string,
    targetMemoryItemId?: string,
    model?: string,
    promptVersion?: string,
  ): CandidateResolutionAudit {
    return {
      relation,
      method,
      confidence: clamp(confidence),
      rationale,
      targetMemoryItemId,
      model,
      promptVersion,
    };
  }
}
