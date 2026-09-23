import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CandidateResolver,
  type AutomationMode,
  type CandidateResolutionResult,
  type CandidateResolverOptions,
} from './candidate-resolver.js';
import { config } from './config.js';
import type {
  QueryUnderstandingResult,
} from './contextual-query-understanding.js';
import { topicTokenOverlap } from './embedding.js';
import { HybridRetrievalIndex } from './hybrid-retrieval.js';
import type { LifecycleStore } from './lifecycle-store.js';
import {
  MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
} from './memory-extractor.js';
import {
  memoryLayerContextFields,
  selectLayeredRecallResults,
} from './memory-layering.js';
import type {
  MemoryStore,
  ReliableRecallOptions,
} from './memory-store.js';
import type {
  MemoryRecord,
  RecallInput,
  RecallResult,
} from './types.js';

type DatabaseRow = Record<string, unknown>;

export const NAMESPACE_QUALITY_EVALUATOR_VERSION =
  'namespace-quality-evaluator-v12';
export const NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256 =
  '262e3b68bb892f288a20b36a093c4de48897046edd9a7c195f51652128df483e';
export const NAMESPACE_QUALITY_DATASET_ID =
  'memory-quality-v1';
export const NAMESPACE_QUALITY_DATASET_SHA256 =
  'a5a1212cac317bc6274ccad2aa207fc29d34ad20bddbe991c77fc8217587c708';

export type NamespaceQualityState =
  | 'unassessed'
  | 'bootstrap'
  | 'passed'
  | 'failed';

export interface NamespaceQualityThresholds {
  extractionPrecision: number;
  candidateRecall: number;
  credentialSaves: number;
  conflictAccuracy: number;
  semanticDuplicateRate: number;
  minExtractionPrecisionSamples: number;
  minCandidateRecallSamples: number;
  minCredentialSamples: number;
  minConflictSamples: number;
  minSemanticDuplicateSamples: number;
}

export const DEFAULT_NAMESPACE_QUALITY_THRESHOLDS:
Readonly<NamespaceQualityThresholds> = Object.freeze({
  extractionPrecision: 0.98,
  candidateRecall: 0.9,
  credentialSaves: 0,
  conflictAccuracy: 0.98,
  semanticDuplicateRate: 0.01,
  minExtractionPrecisionSamples: 100,
  minCandidateRecallSamples: 100,
  minCredentialSamples: 20,
  minConflictSamples: 50,
  minSemanticDuplicateSamples: 100,
});

export interface NamespaceQualitySnapshotInput {
  id?: string;
  userId: string;
  namespace: string;
  metrics: {
    extractionPrecision: number;
    candidateRecall: number;
    credentialSaves: number;
    conflictAccuracy: number;
    semanticDuplicateRate: number;
  };
  samples: {
    extractionPrecision: number;
    candidateRecall: number;
    credentialSafety: number;
    conflictResolution: number;
    semanticDuplicate: number;
  };
  modelVersions: Record<string, string>;
  promptVersions: Record<string, string>;
  evaluatorVersion: string;
  datasetId: string;
  datasetSha256?: string;
  evaluatedAt?: string;
}

export interface NamespaceQualitySnapshot {
  id: string;
  userId: string;
  namespace: string;
  metrics: NamespaceQualitySnapshotInput['metrics'];
  samples: NamespaceQualitySnapshotInput['samples'];
  passed: boolean;
  thresholdResults: Record<string, boolean>;
  failedMetrics: string[];
  modelVersions: Record<string, string>;
  promptVersions: Record<string, string>;
  evaluatorVersion: string;
  datasetId: string;
  datasetSha256: string | null;
  evaluatedAt: string;
  createdAt: string;
}

export interface EffectiveAutomationDecision {
  mode: AutomationMode;
  qualityState: NamespaceQualityState;
  reason:
    | 'global_off'
    | 'global_shadow_ceiling'
    | 'quality_not_evaluated'
    | 'quality_gate_passed'
    | 'quality_gate_failed'
    | 'bootstrap_override_active'
    | 'bootstrap_override_expired'
    | 'runtime_version_mismatch';
  snapshotId: string | null;
  revision: number;
}

export interface NamespaceBootstrapInput {
  userId: string;
  namespace: string;
  reason: string;
  actor: string;
  expiresAt: string;
}

interface NamespaceQualityServiceOptions {
  thresholds?: Partial<NamespaceQualityThresholds>;
  now?: () => string;
}

interface RolloutRow {
  rolloutMode: 'shadow' | 'auto';
  qualityState: NamespaceQualityState;
  activeSnapshotId: string | null;
  overrideKind: 'bootstrap_auto' | null;
  overrideExpiresAt: string | null;
  modelVersions: Record<string, string>;
  promptVersions: Record<string, string>;
  evaluatorVersion: string;
  datasetId: string;
  datasetSha256: string | null;
  revision: number;
}

export interface RecallContext {
  traceId?: string;
  query: string;
  memories: RecallResult[];
  context: string;
  qualityState: 'full' | 'degraded' | 'unavailable';
  queryUnderstanding?: QueryUnderstandingResult;
  grounding?: Array<{
    memoryId: string;
    versionId: string | null;
    evidence: Array<{
      evidenceType: string;
      turnId: string | null;
      sourceRef: string | null;
    }>;
    proofCount?: number;
    firstEvidenceAt?: string | null;
    lastEvidenceAt?: string | null;
    excerpts?: string[];
  }>;
}

export interface RecallSelection extends RecallContext {
  injectionPath: 'hybrid' | 'legacy_fts' | 'none';
  rollout: EffectiveAutomationDecision;
}

export interface NamespaceRecallCoordinatorOptions {
  globalMode?: AutomationMode;
  hybridRecall?: (
    input: RecallInput,
    options?: ReliableRecallOptions,
  ) => Promise<RecallContext>;
  legacyRecall?: (
    input: RecallInput,
  ) => RecallContext | Promise<RecallContext>;
  now?: () => string;
}

function cleanText(value: unknown, fallback = ''): string {
  const normalized =
    typeof value === 'string'
      ? value.normalize('NFKC').trim()
      : '';
  return normalized || fallback;
}

function cleanScope(value: unknown, fallback: string): string {
  const cleaned = cleanText(value, fallback);
  if (cleaned.length > 200) {
    throw new Error('userId/namespace 不能超过 200 个字符');
  }
  return cleaned;
}

function clampMetric(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 必须是 0 到 1 之间的有限数值`);
  }
  return value;
}

function sampleCount(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 样本数必须是非负整数`);
  }
  return value;
}

function isoTimestamp(value: string | undefined, fallback: string): string {
  const timestamp = cleanText(value, fallback);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error('时间必须是有效的 ISO 时间');
  }
  return new Date(timestamp).toISOString();
}

function stringMap(
  value: Record<string, string>,
  name: string,
): Record<string, string> {
  const entries = Object.entries(value)
    .map(([key, item]) => [cleanText(key), cleanText(item)] as const)
    .filter(([key, item]) => key && item);
  if (entries.length === 0) {
    throw new Error(`${name} 至少要记录一个非空版本`);
  }
  return Object.fromEntries(entries);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function memoryText(memory: MemoryRecord): string {
  return [
    memory.title,
    memory.content,
    memory.summary,
    memory.tags.join(' '),
  ].join('\n');
}

function approximateTokenCount(value: string): number {
  const han = (value.match(/\p{Script=Han}/gu) || []).length;
  const remaining = Math.max(0, value.length - han);
  return han + Math.ceil(remaining / 4);
}

function truncateToTokenBudget(value: string, budget: number): string {
  if (approximateTokenCount(value) <= budget) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (approximateTokenCount(value.slice(0, middle)) <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${value.slice(0, low).trimEnd()}…`;
}

function uniqueIds(results: RecallResult[]): string[] {
  return [
    ...new Set(
      results
        .map((result) => cleanText(result.memory.id))
        .filter(Boolean),
    ),
  ];
}

export class NamespaceQualityService {
  readonly thresholds: Readonly<NamespaceQualityThresholds>;
  private readonly currentTime: () => string;

  constructor(
    private readonly database: DatabaseSync,
    options: NamespaceQualityServiceOptions = {},
  ) {
    this.thresholds = Object.freeze({
      ...DEFAULT_NAMESPACE_QUALITY_THRESHOLDS,
      ...options.thresholds,
    });
    this.currentTime =
      options.now || (() => new Date().toISOString());
  }

  effectiveAutomationMode(
    userId: string,
    namespace: string,
    globalMode: AutomationMode = config.automationMode,
  ): EffectiveAutomationDecision {
    const ownerId = cleanScope(userId, config.defaultUserId);
    const targetNamespace = cleanScope(
      namespace,
      config.defaultNamespace,
    );
    const row = this.rolloutRow(ownerId, targetNamespace);
    const base = {
      qualityState: row?.qualityState || 'unassessed' as const,
      snapshotId: row?.activeSnapshotId || null,
      revision: row?.revision || 0,
    };
    if (globalMode === 'off') {
      return { ...base, mode: 'off', reason: 'global_off' };
    }
    if (globalMode === 'shadow') {
      return {
        ...base,
        mode: 'shadow',
        reason: 'global_shadow_ceiling',
      };
    }
    if (!row) {
      return {
        ...base,
        mode: 'shadow',
        reason: 'quality_not_evaluated',
      };
    }
    if (
      row.qualityState === 'passed' &&
      row.rolloutMode === 'auto' &&
      row.activeSnapshotId
    ) {
      if (!this.runtimeVersionsMatch(row)) {
        return {
          ...base,
          mode: 'shadow',
          reason: 'runtime_version_mismatch',
        };
      }
      return {
        ...base,
        mode: 'auto',
        reason: 'quality_gate_passed',
      };
    }
    if (row.qualityState === 'failed') {
      return {
        ...base,
        mode: 'shadow',
        reason: 'quality_gate_failed',
      };
    }
    if (
      row.qualityState === 'bootstrap' &&
      row.overrideKind === 'bootstrap_auto'
    ) {
      const expiresAt = row.overrideExpiresAt
        ? Date.parse(row.overrideExpiresAt)
        : Number.NaN;
      if (
        Number.isFinite(expiresAt) &&
        expiresAt > Date.parse(this.currentTime())
      ) {
        return {
          ...base,
          mode: 'auto',
          reason: 'bootstrap_override_active',
        };
      }
      return {
        ...base,
        mode: 'shadow',
        reason: 'bootstrap_override_expired',
      };
    }
    return {
      ...base,
      mode: 'shadow',
      reason: 'quality_not_evaluated',
    };
  }

  recordSnapshot(
    input: NamespaceQualitySnapshotInput,
  ): NamespaceQualitySnapshot {
    const userId = cleanScope(input.userId, config.defaultUserId);
    const namespace = cleanScope(
      input.namespace,
      config.defaultNamespace,
    );
    const createdAt = isoTimestamp(undefined, this.currentTime());
    const evaluatedAt = isoTimestamp(input.evaluatedAt, createdAt);
    const id = cleanText(input.id, randomUUID());
    const metrics = {
      extractionPrecision: clampMetric(
        input.metrics.extractionPrecision,
        'extractionPrecision',
      ),
      candidateRecall: clampMetric(
        input.metrics.candidateRecall,
        'candidateRecall',
      ),
      credentialSaves: sampleCount(
        input.metrics.credentialSaves,
        'credentialSaves',
      ),
      conflictAccuracy: clampMetric(
        input.metrics.conflictAccuracy,
        'conflictAccuracy',
      ),
      semanticDuplicateRate: clampMetric(
        input.metrics.semanticDuplicateRate,
        'semanticDuplicateRate',
      ),
    };
    const samples = {
      extractionPrecision: sampleCount(
        input.samples.extractionPrecision,
        'extractionPrecision',
      ),
      candidateRecall: sampleCount(
        input.samples.candidateRecall,
        'candidateRecall',
      ),
      credentialSafety: sampleCount(
        input.samples.credentialSafety,
        'credentialSafety',
      ),
      conflictResolution: sampleCount(
        input.samples.conflictResolution,
        'conflictResolution',
      ),
      semanticDuplicate: sampleCount(
        input.samples.semanticDuplicate,
        'semanticDuplicate',
      ),
    };
    const modelVersions = stringMap(
      input.modelVersions,
      'modelVersions',
    );
    const promptVersions = stringMap(
      input.promptVersions,
      'promptVersions',
    );
    const evaluatorVersion = cleanText(input.evaluatorVersion);
    const datasetId = cleanText(input.datasetId);
    if (!evaluatorVersion || !datasetId) {
      throw new Error('evaluatorVersion 和 datasetId 不能为空');
    }
    const datasetSha256 = cleanText(input.datasetSha256) || null;
    if (
      datasetSha256 &&
      !/^[0-9a-f]{64}$/u.test(datasetSha256)
    ) {
      throw new Error('datasetSha256 必须是 64 位小写十六进制');
    }
    const thresholdResults = {
      extractionPrecision:
        metrics.extractionPrecision >=
          this.thresholds.extractionPrecision &&
        samples.extractionPrecision >=
          this.thresholds.minExtractionPrecisionSamples,
      candidateRecall:
        metrics.candidateRecall >= this.thresholds.candidateRecall &&
        samples.candidateRecall >=
          this.thresholds.minCandidateRecallSamples,
      credentialSafety:
        metrics.credentialSaves <= this.thresholds.credentialSaves &&
        samples.credentialSafety >=
          this.thresholds.minCredentialSamples,
      conflictAccuracy:
        metrics.conflictAccuracy >=
          this.thresholds.conflictAccuracy &&
        samples.conflictResolution >=
          this.thresholds.minConflictSamples,
      semanticDuplicateRate:
        metrics.semanticDuplicateRate <
          this.thresholds.semanticDuplicateRate &&
        samples.semanticDuplicate >=
          this.thresholds.minSemanticDuplicateSamples,
    };
    const failedMetrics = Object.entries(thresholdResults)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    const passed = failedMetrics.length === 0;
    const snapshot: NamespaceQualitySnapshot = {
      id,
      userId,
      namespace,
      metrics,
      samples,
      passed,
      thresholdResults,
      failedMetrics,
      modelVersions,
      promptVersions,
      evaluatorVersion,
      datasetId,
      datasetSha256,
      evaluatedAt,
      createdAt,
    };

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO namespace_quality_snapshots (
             id, user_id, namespace,
             extraction_precision, candidate_recall,
             credential_saves, conflict_accuracy,
             semantic_duplicate_rate,
             extraction_precision_samples,
             candidate_recall_samples, credential_samples,
             conflict_samples, semantic_duplicate_samples,
             passed, thresholds_json, threshold_results_json,
             failed_metrics_json, model_versions_json,
             prompt_versions_json, evaluator_version,
             dataset_id, dataset_sha256, evaluated_at, created_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?
           )`,
        )
        .run(
          snapshot.id,
          snapshot.userId,
          snapshot.namespace,
          snapshot.metrics.extractionPrecision,
          snapshot.metrics.candidateRecall,
          snapshot.metrics.credentialSaves,
          snapshot.metrics.conflictAccuracy,
          snapshot.metrics.semanticDuplicateRate,
          snapshot.samples.extractionPrecision,
          snapshot.samples.candidateRecall,
          snapshot.samples.credentialSafety,
          snapshot.samples.conflictResolution,
          snapshot.samples.semanticDuplicate,
          snapshot.passed ? 1 : 0,
          JSON.stringify(this.thresholds),
          JSON.stringify(snapshot.thresholdResults),
          JSON.stringify(snapshot.failedMetrics),
          JSON.stringify(snapshot.modelVersions),
          JSON.stringify(snapshot.promptVersions),
          snapshot.evaluatorVersion,
          snapshot.datasetId,
          snapshot.datasetSha256,
          snapshot.evaluatedAt,
          snapshot.createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO namespace_rollout_state (
             user_id, namespace, rollout_mode, quality_state,
             active_snapshot_id, override_kind, override_reason,
             override_actor, override_created_at,
             override_expires_at, revision, updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1, ?)
           ON CONFLICT(user_id, namespace) DO UPDATE SET
             rollout_mode = excluded.rollout_mode,
             quality_state = excluded.quality_state,
             active_snapshot_id = excluded.active_snapshot_id,
             override_kind = NULL,
             override_reason = NULL,
             override_actor = NULL,
             override_created_at = NULL,
             override_expires_at = NULL,
             revision = namespace_rollout_state.revision + 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          snapshot.userId,
          snapshot.namespace,
          snapshot.passed ? 'auto' : 'shadow',
          snapshot.passed ? 'passed' : 'failed',
          snapshot.id,
          snapshot.createdAt,
        );
      this.insertAudit(
        snapshot.userId,
        'namespace_quality_evaluated',
        {
          namespace: snapshot.namespace,
          snapshotId: snapshot.id,
          passed: snapshot.passed,
          failedMetrics: snapshot.failedMetrics,
          metrics: snapshot.metrics,
          samples: snapshot.samples,
          modelVersions: snapshot.modelVersions,
          promptVersions: snapshot.promptVersions,
          evaluatorVersion: snapshot.evaluatorVersion,
          datasetId: snapshot.datasetId,
          datasetSha256: snapshot.datasetSha256,
        },
        snapshot.createdAt,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return snapshot;
  }

  bootstrapAuto(input: NamespaceBootstrapInput):
  EffectiveAutomationDecision {
    const userId = cleanScope(input.userId, config.defaultUserId);
    const namespace = cleanScope(
      input.namespace,
      config.defaultNamespace,
    );
    const reason = cleanText(input.reason);
    const actor = cleanText(input.actor);
    if (!reason || !actor) {
      throw new Error('bootstrap 必须记录非空 reason 和 actor');
    }
    const createdAt = isoTimestamp(undefined, this.currentTime());
    const expiresAt = isoTimestamp(input.expiresAt, createdAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new Error('bootstrap expiresAt 必须晚于当前时间');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const snapshotCount = Number(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM namespace_quality_snapshots
             WHERE user_id = ? AND namespace = ?`,
          )
          .get(userId, namespace)?.count || 0,
      );
      if (snapshotCount > 0) {
        throw new Error(
          '已有质量评测的 namespace 不能用 bootstrap 绕过门禁',
        );
      }
      const existingBootstrap = this.database
        .prepare(
          `SELECT override_kind
           FROM namespace_rollout_state
           WHERE user_id = ? AND namespace = ?`,
        )
        .get(userId, namespace) as DatabaseRow | undefined;
      if (
        cleanText(existingBootstrap?.override_kind) ===
          'bootstrap_auto'
      ) {
        this.database.exec('COMMIT');
        return this.effectiveAutomationMode(
          userId,
          namespace,
          'auto',
        );
      }
      this.database
        .prepare(
          `INSERT INTO namespace_rollout_state (
             user_id, namespace, rollout_mode, quality_state,
             active_snapshot_id, override_kind, override_reason,
             override_actor, override_created_at,
             override_expires_at, revision, updated_at
           ) VALUES (
             ?, ?, 'auto', 'bootstrap', NULL, 'bootstrap_auto',
             ?, ?, ?, ?, 1, ?
           )
           ON CONFLICT(user_id, namespace) DO UPDATE SET
             rollout_mode = 'auto',
             quality_state = 'bootstrap',
             active_snapshot_id = NULL,
             override_kind = 'bootstrap_auto',
             override_reason = excluded.override_reason,
             override_actor = excluded.override_actor,
             override_created_at = excluded.override_created_at,
             override_expires_at = excluded.override_expires_at,
             revision = namespace_rollout_state.revision + 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          userId,
          namespace,
          reason,
          actor,
          createdAt,
          expiresAt,
          createdAt,
        );
      this.insertAudit(
        userId,
        'namespace_quality_bootstrap_enabled',
        {
          namespace,
          reason,
          actor,
          expiresAt,
        },
        createdAt,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.effectiveAutomationMode(userId, namespace, 'auto');
  }

  latestSnapshot(
    userId: string,
    namespace: string,
  ): NamespaceQualitySnapshot | null {
    const row = this.database
      .prepare(
        `SELECT *
         FROM namespace_quality_snapshots
         WHERE user_id = ? AND namespace = ?
         ORDER BY evaluated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get(
        cleanScope(userId, config.defaultUserId),
        cleanScope(namespace, config.defaultNamespace),
      ) as DatabaseRow | undefined;
    if (!row) return null;
    return {
      id: cleanText(row.id),
      userId: cleanText(row.user_id),
      namespace: cleanText(row.namespace),
      metrics: {
        extractionPrecision: Number(row.extraction_precision),
        candidateRecall: Number(row.candidate_recall),
        credentialSaves: Number(row.credential_saves),
        conflictAccuracy: Number(row.conflict_accuracy),
        semanticDuplicateRate: Number(row.semantic_duplicate_rate),
      },
      samples: {
        extractionPrecision: Number(
          row.extraction_precision_samples,
        ),
        candidateRecall: Number(row.candidate_recall_samples),
        credentialSafety: Number(row.credential_samples),
        conflictResolution: Number(row.conflict_samples),
        semanticDuplicate: Number(row.semantic_duplicate_samples),
      },
      passed: Number(row.passed) === 1,
      thresholdResults: parseJson<Record<string, boolean>>(
        row.threshold_results_json,
        {},
      ),
      failedMetrics: parseJson<string[]>(
        row.failed_metrics_json,
        [],
      ),
      modelVersions: parseJson<Record<string, string>>(
        row.model_versions_json,
        {},
      ),
      promptVersions: parseJson<Record<string, string>>(
        row.prompt_versions_json,
        {},
      ),
      evaluatorVersion: cleanText(row.evaluator_version),
      datasetId: cleanText(row.dataset_id),
      datasetSha256: nullableText(row.dataset_sha256),
      evaluatedAt: cleanText(row.evaluated_at),
      createdAt: cleanText(row.created_at),
    };
  }

  private rolloutRow(
    userId: string,
    namespace: string,
  ): RolloutRow | null {
    const row = this.database
      .prepare(
        `SELECT
           state.*,
           snapshot.model_versions_json,
           snapshot.prompt_versions_json,
           snapshot.evaluator_version,
           snapshot.dataset_id,
           snapshot.dataset_sha256
         FROM namespace_rollout_state state
         LEFT JOIN namespace_quality_snapshots snapshot
           ON snapshot.id = state.active_snapshot_id
         WHERE state.user_id = ? AND state.namespace = ?`,
      )
      .get(userId, namespace) as DatabaseRow | undefined;
    if (!row) return null;
    return {
      rolloutMode:
        cleanText(row.rollout_mode) === 'auto' ? 'auto' : 'shadow',
      qualityState:
        cleanText(row.quality_state) as NamespaceQualityState,
      activeSnapshotId: nullableText(row.active_snapshot_id),
      overrideKind:
        cleanText(row.override_kind) === 'bootstrap_auto'
          ? 'bootstrap_auto'
          : null,
      overrideExpiresAt: nullableText(row.override_expires_at),
      modelVersions: parseJson<Record<string, string>>(
        row.model_versions_json,
        {},
      ),
      promptVersions: parseJson<Record<string, string>>(
        row.prompt_versions_json,
        {},
      ),
      evaluatorVersion: cleanText(row.evaluator_version),
      datasetId: cleanText(row.dataset_id),
      datasetSha256: nullableText(row.dataset_sha256),
      revision: Math.max(1, Number(row.revision) || 1),
    };
  }

  private runtimeVersionsMatch(row: RolloutRow): boolean {
    return (
      row.modelVersions.extraction === config.extractionModel &&
      row.modelVersions.relation === config.relationModel &&
      row.modelVersions.rerank === config.rerankModel &&
      row.modelVersions.embedding === config.embeddingModel &&
      row.modelVersions.extractorImplementation ===
        MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT &&
      row.modelVersions.qualityPipelineImplementation ===
        NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256 &&
      row.promptVersions.extraction ===
        config.extractionPromptVersion &&
      row.promptVersions.relation === config.relationPromptVersion &&
      row.evaluatorVersion === NAMESPACE_QUALITY_EVALUATOR_VERSION &&
      row.datasetId === NAMESPACE_QUALITY_DATASET_ID &&
      row.datasetSha256 === NAMESPACE_QUALITY_DATASET_SHA256
    );
  }

  private insertAudit(
    userId: string,
    action: string,
    detail: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO audit_log (
           id, action, memory_id, user_id, detail_json, created_at
         )
         SELECT COALESCE(MAX(id), 0) + 1, ?, NULL, ?, ?, ?
         FROM audit_log
         WHERE user_id = ?`,
      )
      .run(
        action,
        userId,
        JSON.stringify(detail),
        createdAt,
        userId,
      );
  }
}

export class NamespaceGatedCandidateResolver extends CandidateResolver {
  private readonly shadowResolver: CandidateResolver;
  private readonly offResolver: CandidateResolver;

  constructor(
    database: DatabaseSync,
    lifecycleStore: LifecycleStore,
    memoryStore: MemoryStore,
    private readonly qualityService: NamespaceQualityService,
    private readonly globalMode: AutomationMode,
    options: Omit<CandidateResolverOptions, 'mode'>,
  ) {
    super(database, lifecycleStore, memoryStore, {
      ...options,
      mode: 'auto',
    });
    this.shadowResolver = new CandidateResolver(
      database,
      lifecycleStore,
      memoryStore,
      { ...options, mode: 'shadow' },
    );
    this.offResolver = new CandidateResolver(
      database,
      lifecycleStore,
      memoryStore,
      { ...options, mode: 'off' },
    );
    this.candidateStore = lifecycleStore;
  }

  private readonly candidateStore: LifecycleStore;

  override async resolve(
    candidateId: string,
  ): Promise<CandidateResolutionResult> {
    const candidate = this.candidateStore.getCandidate(candidateId);
    if (!candidate) return await super.resolve(candidateId);
    const decision = this.qualityService.effectiveAutomationMode(
      candidate.userId,
      candidate.namespace,
      this.globalMode,
    );
    if (decision.mode === 'off') {
      return await this.offResolver.resolve(candidateId);
    }
    if (decision.mode === 'shadow') {
      return await this.shadowResolver.resolve(candidateId);
    }
    return await super.resolve(candidateId);
  }
}

export class NamespaceRecallCoordinator {
  private readonly globalMode: AutomationMode;
  private readonly hybridRecall: (
    input: RecallInput,
    options?: ReliableRecallOptions,
  ) => Promise<RecallContext>;
  private readonly legacyRecall: (
    input: RecallInput,
  ) => RecallContext | Promise<RecallContext>;
  private readonly currentTime: () => string;
  private readonly retrievalIndex: HybridRetrievalIndex;

  constructor(
    private readonly database: DatabaseSync,
    private readonly memoryStore: MemoryStore,
    private readonly qualityService: NamespaceQualityService,
    options: NamespaceRecallCoordinatorOptions = {},
  ) {
    this.globalMode = options.globalMode || config.automationMode;
    this.hybridRecall =
      options.hybridRecall ||
      ((input, recallOptions) =>
        this.memoryStore.getContextReliable(input, recallOptions));
    this.legacyRecall =
      options.legacyRecall ||
      ((input) => this.legacyFtsContext(input));
    this.currentTime =
      options.now || (() => new Date().toISOString());
    this.retrievalIndex = new HybridRetrievalIndex(database);
  }

  async recallForLifecycle(
    input: RecallInput,
    recallOptions: ReliableRecallOptions = {},
  ):
  Promise<RecallSelection> {
    const userId = cleanScope(input.userId, config.defaultUserId);
    const namespace = cleanScope(
      input.namespace,
      config.defaultNamespace,
    );
    const scopedInput = { ...input, userId, namespace };
    const rollout = this.qualityService.effectiveAutomationMode(
      userId,
      namespace,
      this.globalMode,
    );
    const hybridPromise = this.hybridRecall(
      scopedInput,
      recallOptions,
    ).catch(
      (): RecallContext => ({
        query: scopedInput.query,
        memories: [],
        context: '长期记忆语义服务当前不可用，本轮未注入新召回结果。',
        qualityState: 'unavailable',
      }),
    );
    const legacyPromise = Promise.resolve(
      this.legacyRecall(scopedInput),
    ).catch(
      (): RecallContext => ({
        query: scopedInput.query,
        memories: [],
        context: '没有找到与当前问题相关的长期记忆。',
        qualityState: 'degraded',
      }),
    );
    const [hybrid, legacy] = await Promise.all([
      hybridPromise,
      legacyPromise,
    ]);
    const requiresClarification =
      hybrid.queryUnderstanding?.status === 'ambiguous' ||
      (
        hybrid.queryUnderstanding?.status === 'unavailable' &&
        hybrid.queryUnderstanding.triggerReasons.length > 0
      );
    // Candidate auto-commit rollout and per-request retrieval quality are
    // independent gates. A full hybrid result is safe to inject even while
    // extraction remains in shadow; degraded/unavailable recall still falls
    // back to the conservative lexical path.
    const injectHybrid = requiresClarification ||
      hybrid.qualityState === 'full';
    const selected = injectHybrid ? hybrid : legacy;
    const selectedIds = uniqueIds(selected.memories);
    const injectionPath =
      selectedIds.length === 0
        ? 'none' as const
        : injectHybrid
          ? 'hybrid' as const
          : 'legacy_fts' as const;
    const selection: RecallSelection = {
      ...selected,
      qualityState: injectHybrid
        ? hybrid.qualityState
        : hybrid.qualityState === 'unavailable' &&
            legacy.memories.length === 0
          ? 'unavailable'
          : 'degraded',
      injectionPath,
      rollout,
    };
    this.recordComparison({
      userId,
      namespace,
      query: scopedInput.query,
      hybrid,
      legacy,
      injectedResultIds: selectedIds,
      injectionPath,
      rollout,
    });
    return selection;
  }

  private legacyFtsContext(input: RecallInput): RecallContext {
    const userId = cleanScope(input.userId, config.defaultUserId);
    const namespace = cleanScope(
      input.namespace,
      config.defaultNamespace,
    );
    const limit = Math.max(1, Math.min(input.limit || 8, 30));
    const candidates = this.retrievalIndex
      .search({
        query: cleanText(input.query),
        userId,
        namespace,
        kinds: input.kinds,
        tags: input.tags,
        includeArchived: input.includeArchived,
        scopes: input.scopes,
        scopeType: input.scopeType,
        scopeKey: input.scopeKey,
        allowedSensitivities: input.allowedSensitivities,
        limit: config.maxRecallCandidates,
        timestamp: this.currentTime(),
      })
      .filter(
        (candidate) => candidate.lexicalRank !== null,
      )
      .sort(
        (left, right) =>
          (left.lexicalRank || Number.MAX_SAFE_INTEGER) -
          (right.lexicalRank || Number.MAX_SAFE_INTEGER),
      );
    const rankedMemories = candidates
      .flatMap((candidate): RecallResult[] => {
        const memory = this.memoryStore.get(
          candidate.id,
          false,
          userId,
        );
        if (!memory) return [];
        const overlap = topicTokenOverlap(
          input.query,
          memoryText(memory),
        );
        if (overlap < 0.3) return [];
        const rank = candidate.lexicalRank || candidates.length + 1;
        return [{
          memory,
          score: Number(
            Math.max(0.5, 1 - (rank - 1) * 0.05).toFixed(4),
          ),
          reasons: [
            `legacy FTS5/BM25 第 ${rank} 名`,
            '高精度主题词重叠',
          ],
          explanation: {
            lexicalRank: rank,
            annRank: null,
            termRank: null,
            graphRank: null,
            semanticSimilarity: 0,
            rerankConfidence: null,
            feedbackPrior: 0,
            importance: Number(memory.importance.toFixed(4)),
            memoryConfidence: Number(
              memory.confidence.toFixed(4),
            ),
            recency: 0,
            status: memory.status,
            conflictState:
              memory.status === 'archived'
                ? 'archived'
                : memory.status === 'superseded'
                  ? 'superseded'
                  : 'none',
            diversityPenalty: 0,
          },
        }];
      });
    const memories = selectLayeredRecallResults(
      this.memoryStore.applyScopePrecedence(rankedMemories).results,
      limit,
    );
    return {
      query: input.query,
      memories,
      context: this.buildLegacyContext(
        memories,
        userId,
        input.contextTokenBudget,
      ),
      qualityState: 'degraded',
    };
  }

  private buildLegacyContext(
    memories: RecallResult[],
    userId: string,
    requestedBudget?: number,
  ): string {
    if (memories.length === 0) {
      return '没有找到与当前问题相关的长期记忆。';
    }
    const budget = Math.max(
      256,
      Math.min(
        Math.trunc(
          requestedBudget || config.memoryContextTokenBudget,
        ),
        8_192,
      ),
    );
    const item = this.database.prepare(
      `SELECT current_version_id
       FROM memory_items
       WHERE id = ? AND user_id = ?`,
    );
    const evidence = this.database.prepare(
      `SELECT evidence_type, turn_id, source_ref
       FROM memory_evidence
       WHERE memory_version_id = ?
       ORDER BY created_at ASC
       LIMIT 2`,
    );
    const entries: string[] = [];
    let used = 0;
    for (const [index, result] of memories.entries()) {
      const layer = memoryLayerContextFields(result.memory.source);
      const itemRow = item.get(
        result.memory.id,
        userId,
      ) as DatabaseRow | undefined;
      const versionId = nullableText(
        itemRow?.current_version_id,
      );
      const evidenceRows = versionId
        ? evidence.all(versionId) as DatabaseRow[]
        : [];
      const sourceSummary = evidenceRows.length > 0
        ? evidenceRows
            .map((row) => {
              const reference =
                nullableText(row.turn_id) ||
                nullableText(row.source_ref) ||
                'internal';
              return `${cleanText(row.evidence_type)}@${reference}`;
            })
            .join(', ')
        : `${result.memory.source}` +
          (result.memory.sourceRef
            ? `@${result.memory.sourceRef}`
            : '');
      const entry = [
        `${layer.heading} ${index + 1}`,
        `memory_id: ${result.memory.id}`,
        `version_id: ${versionId || 'legacy-unversioned'}`,
        `类型/作用域: ${result.memory.kind}/${result.memory.namespace}`,
        `来源摘要: ${sourceSummary}`,
        `${layer.contentLabel}: ${result.memory.content}`,
        ...(layer.caution ? [`使用约束: ${layer.caution}`] : []),
        `置信度/召回分: ${result.memory.confidence.toFixed(2)}/${result.score.toFixed(2)}`,
        `召回依据: ${result.reasons.join('；')}`,
      ].join('\n');
      const cost = approximateTokenCount(entry);
      if (used + cost > budget) {
        if (entries.length === 0) {
          entries.push(truncateToTokenBudget(entry, budget));
        }
        break;
      }
      entries.push(entry);
      used += cost;
    }
    return entries.join('\n\n');
  }

  private recordComparison(input: {
    userId: string;
    namespace: string;
    query: string;
    hybrid: RecallContext;
    legacy: RecallContext;
    injectedResultIds: string[];
    injectionPath: RecallSelection['injectionPath'];
    rollout: EffectiveAutomationDecision;
  }): void {
    const newIds = uniqueIds(input.hybrid.memories);
    const legacyIds = uniqueIds(input.legacy.memories);
    const newSet = new Set(newIds);
    const legacySet = new Set(legacyIds);
    const newOnly = newIds.filter((id) => !legacySet.has(id));
    const legacyOnly = legacyIds.filter((id) => !newSet.has(id));
    this.database
      .prepare(
        `INSERT INTO namespace_recall_shadow_comparisons (
           id, user_id, namespace, query_hash,
           new_result_ids_json, legacy_result_ids_json,
           new_only_ids_json, legacy_only_ids_json,
           injected_result_ids_json, injection_path,
           effective_mode, decision_reason, quality_state, snapshot_id,
           new_recall_quality, created_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        randomUUID(),
        input.userId,
        input.namespace,
        createHash('sha256')
          .update(cleanText(input.query))
          .digest('hex'),
        JSON.stringify(newIds),
        JSON.stringify(legacyIds),
        JSON.stringify(newOnly),
        JSON.stringify(legacyOnly),
        JSON.stringify(input.injectedResultIds),
        input.injectionPath,
        input.rollout.mode,
        input.rollout.reason,
        input.rollout.qualityState,
        input.rollout.snapshotId,
        input.hybrid.qualityState,
        isoTimestamp(undefined, this.currentTime()),
      );
  }
}
