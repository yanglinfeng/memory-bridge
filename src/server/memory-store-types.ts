/**
 * MemoryStore 公开与内部类型定义（原 memory-store.ts 96-307 行）。
 *
 * 由 memory-store.ts 机械搬迁而来（仅加 export 前缀），公开符号由门面 re-export。
 */

import type {
  MemoryAccessScope,
  MemoryRecord,
} from './types.js';
import type {
  HybridCandidate,
  HybridSearchDiagnostics,
} from './hybrid-retrieval.js';
import type { QueryUnderstandingResult } from './contextual-query-understanding.js';
import type { ClaimRelationAssessment } from './claim-relation-engine.js';

export type DatabaseRow = Record<string, unknown>;

export interface IndexedRecallCandidate {
  memory: MemoryRecord;
  semanticRevision: number;
  retrieval: HybridCandidate;
  rawEmbedding: unknown;
  queryVariantHits: string[];
}

export interface IndexedRecallSearch {
  candidates: IndexedRecallCandidate[];
  diagnostics: HybridSearchDiagnostics;
}

export interface QueryVariant {
  query: string;
  type:
    | 'original'
    | 'contextual'
    | 'contextual_variant'
    | 'normalized'
    | 'alias'
    | 'llm';
}

export interface MemoryEvidenceDigest {
  versionId: string | null;
  proofCount: number;
  firstEvidenceAt: string | null;
  lastEvidenceAt: string | null;
  excerpts: string[];
  evidence: Array<{
    evidenceType: string;
    turnId: string | null;
    sourceRef: string | null;
  }>;
}

export type TemporalRetrievalKind =
  | 'history_sequence'
  | 'recent'
  | 'today'
  | 'yesterday'
  | 'tomorrow'
  | 'this_week'
  | 'last_week'
  | 'next_week'
  | 'this_month'
  | 'last_month';

export interface TemporalRetrievalPlan {
  kind: TemporalRetrievalKind;
  label: string;
  referenceAt: string;
  rangeStartMs: number | null;
  rangeEndMs: number | null;
}

export interface TemporalCandidateSignal {
  score: number;
  anchorAt: string;
  anchorSource:
    | 'trusted_user_evidence'
    | 'occurred_at'
    | 'last_seen_at'
    | 'updated_at';
}

export interface ReliableRecallOptions {
  qosClass?: 'foreground' | 'background';
  queryUnderstanding?: QueryUnderstandingResult;
  qualityFallback?: () => Promise<QueryUnderstandingResult>;
  qualityFallbackAttempted?: boolean;
  traceContext?: {
    source: 'mcp' | 'lifecycle' | 'http';
    correlationId: string;
  };
  onTraceCreated?: (traceId: string) => void;
}

export interface RetrievalCandidateDecision {
  memoryId: string;
  stage: 'semantic' | 'rerank' | 'selection';
  decision: 'rejected' | 'not_evaluated';
  evaluated: boolean;
  reasonCode: string;
  score?: number;
  threshold?: number;
}

export interface DenseIndexMemory {
  memory: MemoryRecord;
  semanticRevision: number;
}

export interface DenseIndexWatermark {
  generationId: string | null;
  modelId: string | null;
  model: string | null;
  indexVersion: string;
  dimensions: number | null;
  generationKey: string | null;
  eligible: number;
  indexed: number;
  complete: boolean;
}

export interface DenseBackfillResult extends DenseIndexWatermark {
  processed: number;
  available: boolean;
  telemetry: DenseIndexTelemetry;
}

export interface DenseIndexTelemetry {
  batchSize: number;
  batchLeaderJobId: string | null;
  physicalWorkAttributed: boolean;
  probeDurationMs: number;
  embeddingDurationMs: number;
  databaseWriteDurationMs: number;
  watermarkDurationMs: number;
  embeddingBatchCalls: number;
  watermarkDeferred: boolean;
}

export interface DenseIncrementalIndexOptions {
  /**
   * A queued single-memory job may defer the expensive scope-wide watermark
   * until it is the last open index job for the same scope and generation.
   */
  deferScopeWatermarkUntilQueueTail?: boolean;
  currentJobId?: string;
  currentJobIds?: string[];
  deferScopeWatermarkAlways?: boolean;
  /** The worker already probed and registered its generation capabilities. */
  reusePreparedGenerationProbe?: boolean;
}

export interface DenseIndexEvaluationCaseResult {
  caseId: string;
  expectedMemoryId: string;
  retrievedMemoryIds: string[];
  rank: number | null;
  hitAt20: boolean;
  reciprocalRank: number;
}

export interface DenseIndexEvaluationReport {
  evaluationId: string;
  generationId: string;
  modelId: string;
  embeddingModel: string;
  generationKey: string;
  dimensions: number;
  datasetId: string;
  datasetSha256: string;
  evaluatorVersion: string;
  queryCount: number;
  recallAt20: number;
  mrrAt10: number;
  passed: boolean;
  startedAt: string;
  completedAt: string;
  cases: DenseIndexEvaluationCaseResult[];
}

export interface ObserveMemoryInput {
  expectedRevision: number;
  evidenceTurnId?: string;
  evidenceExcerpt?: string;
  sourceRef?: string;
  sensitivity: MemoryRecord['sensitivity'];
  sourceAuthority: MemoryRecord['sourceAuthority'];
  idempotencyKey?: string;
}

export interface TombstoneWriteAuthorization {
  purpose: 'restore-reconciliation';
  tombstoneId: string;
}

export interface ForgetTransactionAuthorization {
  expectedNamespace: string;
  authorizedScopes: readonly MemoryAccessScope[];
  beforeCommit?: (deleted: MemoryRecord) => void;
}

export interface RestoreMemoryInput {
  confirmation?: 'replace';
  confirmationToken?: string;
}

export interface RestoreAssessmentSnapshot {
  relation: ClaimRelationAssessment['relation'];
  targetMemoryId: string | null;
  method: ClaimRelationAssessment['method'];
  confidence: number;
  rationale: string;
  model: string | null;
  promptVersion: string | null;
  actionPlan: 'restore' | 'merge' | 'replace';
}

export interface RestoreDecisionResult {
  status: 'restored' | 'merged' | 'requires_confirmation';
  memory: MemoryRecord;
  conflicts: MemoryRecord[];
  tombstonesRestored: number;
  confirmationToken: string | null;
  assessment: RestoreAssessmentSnapshot | null;
}

