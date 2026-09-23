import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { isClientIdentityId } from './client-identity-contract.js';
import { config } from './config.js';
import type {
  QueryUnderstandingResult,
} from './contextual-query-understanding.js';
import { SCHEMA_VERSION } from './database.js';
import {
  DENSE_EVALUATION_DATASET_ID,
  DENSE_EVALUATION_DATASET_SHA256,
  DENSE_EVALUATION_MRR_AT_10_MIN,
  DENSE_EVALUATION_QUERY_COUNT,
  DENSE_EVALUATION_RECALL_AT_20_MIN,
  DENSE_EVALUATOR_VERSION,
} from './dense-evaluation-contract.js';
import {
  bufferToVector,
  cosineSimilarity,
  embedText,
  tokenOverlap,
  topicTokenOverlap,
  vectorToBuffer,
} from './embedding.js';
import type {
  SemanticCandidate,
  SemanticOperationTelemetry,
  SemanticRanker,
} from './semantic-ranker.js';
import {
  deterministicAtomicProfilePredicateMatches,
  deterministicAtomicProfileQueryRule,
  semanticOperationFailure,
} from './semantic-ranker.js';
import { containsCredentialSecret } from './memory-extractor.js';
import type {
  ClaimRelationAssessment,
} from './claim-relation-engine.js';
import {
  MemoryJournal,
  type ActiveMemoryTombstone,
  type MemoryVersionRecord,
} from './memory-journal.js';
import {
  classifyMemoryLayer,
  memoryLayerContextFields,
  selectLayeredRecallResults,
} from './memory-layering.js';
import { beginForegroundActivity } from './model-qos.js';
import {
  canonicalContentHash,
  findBlockingTombstone,
  type TombstoneClaimIdentity,
} from './tombstone-policy.js';
import {
  DENSE_LSH_BANDS,
  DENSE_LSH_VERSION,
  HybridRetrievalIndex,
  deriveDenseGenerationIdentity,
  normalizeAccessScopes,
  type DenseGenerationRegistration,
  type DenseIndexAlias,
  type DenseIndexGeneration,
  type HybridCandidate,
  type HybridSearchDiagnostics,
} from './hybrid-retrieval.js';
import {
  RetrievalObservability,
  sanitizeAuditDetail,
  type RetrievalLogHealth,
  type RetrievalQualityState,
  type RetrievalTraceDetail,
  type RetrievalTraceSession,
  type RetrievalTraceSummary,
  retrievalQueryHash,
} from './retrieval-observability.js';
import type {
  AuditRecord,
  MemoryAccessScope,
  MemoryListInput,
  MemoryListResult,
  MemoryOrigin,
  MemoryRecord,
  MemoryStats,
  PredicateCardinality,
  RecallInput,
  RecallResult,
  RememberInput,
  UpdateMemoryInput,
} from './types.js';
import { MEMORY_KINDS } from './types.js';
import type { CorpusDomain } from './types.js';
import type { MemoryClassification } from './types.js';

import {
  DENSE_GENERATION_PROBE,
  memoryBackupSchema,
} from './memory-store-schemas.js';
import type {
  FullBackupState,
  MemoryBackup,
} from './memory-store-schemas.js';
import type {
  DatabaseRow,
  DenseBackfillResult,
  DenseIncrementalIndexOptions,
  DenseIndexEvaluationReport,
  DenseIndexMemory,
  DenseIndexWatermark,
  ForgetTransactionAuthorization,
  IndexedRecallCandidate,
  IndexedRecallSearch,
  MemoryEvidenceDigest,
  ObserveMemoryInput,
  QueryVariant,
  ReliableRecallOptions,
  RestoreAssessmentSnapshot,
  RestoreDecisionResult,
  RestoreMemoryInput,
  RetrievalCandidateDecision,
  TemporalCandidateSignal,
  TemporalRetrievalKind,
  TemporalRetrievalPlan,
  TombstoneWriteAuthorization,
} from './memory-store-types.js';
export type { MemoryBackup } from './memory-store-schemas.js';
export type {
  DenseBackfillResult,
  DenseIncrementalIndexOptions,
  DenseIndexEvaluationCaseResult,
  DenseIndexEvaluationReport,
  DenseIndexTelemetry,
  DenseIndexWatermark,
  ForgetTransactionAuthorization,
  ObserveMemoryInput,
  ReliableRecallOptions,
  RestoreAssessmentSnapshot,
  RestoreDecisionResult,
  RestoreMemoryInput,
  TombstoneWriteAuthorization,
} from './memory-store-types.js';

function now(): string {
  return new Date().toISOString();
}

function temporalRangesOverlap(
  left: MemoryRecord,
  right: MemoryRecord,
): boolean {
  const leftStart = Date.parse(left.validFrom || left.occurredAt || '');
  const leftEnd = Date.parse(left.validTo || '');
  const rightStart = Date.parse(
    right.validFrom || right.occurredAt || '',
  );
  const rightEnd = Date.parse(right.validTo || '');
  if (
    Number.isFinite(leftStart) &&
    Number.isFinite(rightEnd) &&
    leftStart >= rightEnd
  ) {
    return false;
  }
  if (
    Number.isFinite(rightStart) &&
    Number.isFinite(leftEnd) &&
    rightStart >= leftEnd
  ) {
    return false;
  }
  return true;
}

function clamp(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function cleanText(value: string | undefined, fallback = ''): string {
  return (value || fallback).normalize('NFKC').trim();
}

function normalizedRetrievalSignal(value: string | null | undefined): string {
  return cleanText(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase();
}

function hasQualityFallbackQueryDelta(
  originalQuery: string,
  understanding: QueryUnderstandingResult | null,
): understanding is QueryUnderstandingResult {
  if (
    understanding?.status !== 'resolved' &&
    understanding?.status !== 'not_needed'
  ) return false;
  const original = normalizedRetrievalSignal(originalQuery);
  return [
    understanding.standaloneQuery,
    understanding.rankingQuery,
    ...understanding.variants,
  ].some((value) => {
    const signal = normalizedRetrievalSignal(value);
    return Boolean(signal) && signal !== original;
  });
}

function queryUnderstandingTraceTelemetry(
  understanding: QueryUnderstandingResult | null | undefined,
): Record<string, unknown> {
  if (!understanding) return {};
  const telemetry = understanding?.telemetry;
  const decisionSource = understanding?.decisionSource || 'none';
  const derivedRoute = decisionSource.startsWith('deterministic')
    ? 'deterministic_fast'
    : decisionSource.startsWith('model') ? 'model' : 'unavailable';
  return {
    route: telemetry?.route || derivedRoute,
    providerCalls: telemetry?.providerCalls || 0,
    cacheHit: telemetry?.cacheHit || false,
    singleFlightShared: telemetry?.singleFlightShared || false,
    keyFingerprint: telemetry?.keyFingerprint || null,
    queryDelta: telemetry?.queryDelta || false,
    variantDelta: telemetry?.variantDelta || false,
    requestDurationMs: telemetry?.requestDurationMs || 0,
    providerDurationMs: telemetry?.providerDurationMs ?? null,
    modelTelemetry: telemetry?.model || null,
  };
}

function semanticOperationTraceTelemetry(
  telemetry: SemanticOperationTelemetry,
): Record<string, unknown> {
  return {
    route: telemetry.route,
    providerCalls: telemetry.providerCalls,
    baseProviderCalls: telemetry.baseProviderCalls ?? 0,
    firstCandidateConfirmationCalls:
      telemetry.firstCandidateConfirmationCalls ?? 0,
    protocolRecoveryCalls: telemetry.protocolRecoveryCalls ?? 0,
    protocolRecoveryMaxDepth: telemetry.protocolRecoveryMaxDepth ?? 0,
    parallelBatchCount: telemetry.parallelBatchCount ?? 0,
    providerQueueWaitMs: telemetry.providerQueueWaitMs ?? 0,
    providerPeakActive: telemetry.providerPeakActive ?? 0,
    providerMaxConcurrency: telemetry.providerMaxConcurrency ?? 0,
    cacheHit: telemetry.cacheHit,
    singleFlightShared: telemetry.singleFlightShared,
    keyFingerprint: telemetry.keyFingerprint,
    requestDurationMs: telemetry.requestDurationMs,
    providerDurationMs: telemetry.providerDurationMs,
    modelTelemetry: telemetry.model,
  };
}

function legacySemanticOperationTelemetry(
  route: SemanticOperationTelemetry['route'],
  keyFingerprint: string,
  requestDurationMs: number,
  providerCalls: number,
): SemanticOperationTelemetry {
  return {
    route,
    providerCalls,
    cacheHit: false,
    singleFlightShared: false,
    keyFingerprint,
    requestDurationMs,
    providerDurationMs: providerCalls > 0 ? requestDurationMs : null,
    model: null,
  };
}

function aggregateSemanticOperationTraceTelemetry(
  telemetry: readonly SemanticOperationTelemetry[],
): Record<string, unknown> {
  const attempts = telemetry.map(semanticOperationTraceTelemetry);
  const route = telemetry.some((attempt) => attempt.route === 'model')
    ? 'model'
    : telemetry.some((attempt) => attempt.route === 'cache')
      ? 'cache'
      : 'deterministic_fast';
  const providerDurationMs = telemetry.reduce(
    (total, attempt) => total + (attempt.providerDurationMs || 0),
    0,
  );
  return {
    route,
    providerCalls: telemetry.reduce(
      (total, attempt) => total + attempt.providerCalls,
      0,
    ),
    cacheHit: telemetry.some((attempt) => attempt.cacheHit),
    singleFlightShared: telemetry.some(
      (attempt) => attempt.singleFlightShared,
    ),
    keyFingerprint: telemetry.length === 1
      ? telemetry[0].keyFingerprint
      : null,
    requestDurationMs: Number(telemetry.reduce(
      (total, attempt) => total + attempt.requestDurationMs,
      0,
    ).toFixed(3)),
    providerDurationMs: providerDurationMs > 0
      ? Number(providerDurationMs.toFixed(3))
      : null,
    providerQueueWaitMs: Number(telemetry.reduce(
      (total, attempt) => total + (attempt.providerQueueWaitMs || 0),
      0,
    ).toFixed(3)),
    providerPeakActive: telemetry.reduce(
      (maximum, attempt) => Math.max(
        maximum,
        attempt.providerPeakActive || 0,
      ),
      0,
    ),
    providerMaxConcurrency: telemetry.reduce(
      (maximum, attempt) => Math.max(
        maximum,
        attempt.providerMaxConcurrency || 0,
      ),
      0,
    ),
    modelTelemetry: telemetry.length === 1
      ? telemetry[0].model
      : null,
    attempts,
  };
}

const PERSONALIZED_SYNTHESIS_QUERY_PATTERN =
  /(?:(?:根据|结合).{0,20}(?:长期|了解|记忆|习惯|偏好).{0,24}(?:安排|计划|建议|清单)|(?:个性化|懂我).{0,16}(?:安排|计划|建议|清单)|(?:我的|用户).{0,12}(?:习惯|偏好).{0,16}(?:安排|计划|建议|清单))/u;

export function deterministicPersonalizationQueryFacets(
  query: string,
): string[] {
  const normalized = cleanText(query);
  if (!PERSONALIZED_SYNTHESIS_QUERY_PATTERN.test(normalized)) {
    return [];
  }
  return [
    '用户当前时段的日常习惯 饮食饮品 作息',
    '用户工作习惯 工作偏好 决策方式 任务安排',
    '用户沟通偏好 回答方式 当前角色称呼',
  ];
}

function deterministicQueryVariants(query: string): QueryVariant[] {
  const original = cleanText(query);
  const personalizationFacets =
    deterministicPersonalizationQueryFacets(original);
  if (personalizationFacets.length > 0) {
    return [
      { query: original, type: 'original' },
      ...personalizationFacets.map((facet): QueryVariant => ({
        query: facet,
        type: 'alias',
      })),
    ];
  }
  const normalized = original
    .replace(/[？?！!。.,，；;：:]+$/gu, '')
    .replace(
      /^(?:请问|我想问(?:一下)?|帮我(?:查|找|回忆)(?:一下)?|你还记得|那个)\s*/u,
      '',
    )
    .replace(/\s+/gu, ' ')
    .trim();
  const aliasRules: Array<[RegExp, string]> = [
    [/(?:第一次打开|首次打开|初次启动|首次启动)/gu, '首次启动 初次打开 第一次打开'],
    [/(?:喜欢|偏好|首选|优先选择)/gu, '喜欢 偏好 首选'],
    [/(?:叫什么|名称|名字)/gu, '名称 名字 叫什么'],
    [/(?:现在|当前|目前)/gu, '现在 当前 最新'],
    [/(?:不要|不需要|无需)/gu, '不要 不需要 无需'],
    [/(?:软件|应用|产品)/gu, '软件 应用 产品'],
    [/\b(?:first launch|initial startup|first startup)\b/giu,
      'first launch initial startup first startup'],
    [/\b(?:preference|prefer|favorite)\b/giu,
      'preference prefer favorite'],
  ];
  let alias = normalized || original;
  for (const [pattern, replacement] of aliasRules) {
    alias = alias.replace(pattern, replacement);
  }
  const variants: QueryVariant[] = [{ query: original, type: 'original' }];
  if (normalized && normalized !== original) {
    variants.push({ query: normalized, type: 'normalized' });
  }
  if (alias && !variants.some((variant) => variant.query === alias)) {
    variants.push({ query: alias, type: 'alias' });
  }
  return variants;
}

const HIGH_ENTROPY_IDENTIFIER_PATTERN =
  /[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}/gu;
const RERANK_COARSE_SCORE_CLIFF_RATIO = 0.65;
const RERANK_HIGH_CONFIDENCE = 0.9;
const NON_ATOMIC_SINGLE_VALUE_QUERY_PATTERN =
  /(清单|几个|哪些|都|分别|比较|对比|总结|概括|计划|建议|最近|过去|本周|上周|今天|昨天|时间范围|时间段|变化|趋势|有什么|包括|列出|多少|各自|综合|它|他|她|这个|那个|这些|那些)/u;
const EXPLICIT_EXHAUSTIVE_RECALL_QUERY_PATTERN =
  /(?:列出|罗列|枚举).{0,48}(?:所有|全部|每个|分别)/u;
const EXPLICIT_ATOMIC_SINGLE_VALUE_QUERY_PATTERN =
  /(?:(?:当前|目前|现在|首选|唯一|默认|主要).*(?:是什么|是哪一个|哪个|什么)|(?:姓名|名字|生日|邮箱|电话|地址|代号|称呼).*(?:是什么|是哪一个|哪个|什么)|叫什么|在哪里|何时|什么时候)(?:[？?。.]*)$/u;
const ATOMIC_VALUE_VERIFICATION_QUERY_PATTERN =
  /(?:是否|是不是|还有效|仍然有效|依然有效|吗)(?:[？?。.]*)$/u;
const EXPLICIT_VERBATIM_USER_EVIDENCE_QUERY_PATTERN =
  /^(?:我|用户|本人)(?:(?:是不是|是否)(?:曾经)?(?:要求|希望)(?:你)?|(?:有没有|是否)(?:曾经)?说过).+?(?:吗)?[？?]?$/u;
const STABLE_ATOMIC_PROFILE_RULES = new Set([
  'favorite_drink',
  'occupation',
  'home_city',
  'food_aversion',
  'learning_goal',
  'commute_mode',
  'editor',
  'response_style',
]);

function atomicQueryVariant(value: string): string {
  return cleanText(value).replace(
    /(?:当前|这个|该)角色/gu,
    '角色',
  );
}

function atomicValueClearlyMatchesQuery(
  query: string,
  value: string,
): boolean {
  const normalizedQuery = cleanText(query).normalize('NFKC');
  const normalizedValue = cleanText(value).normalize('NFKC');
  return normalizedValue.length > 0 && (
    normalizedQuery.includes(normalizedValue) ||
    tokenOverlap(normalizedQuery, normalizedValue) >= 0.45 ||
    topicTokenOverlap(normalizedQuery, normalizedValue) >= 0.2
  );
}

function atomicValuesClearlyConflictWithQuery(
  query: string,
  values: readonly string[],
): boolean {
  return values.length > 0 && values.every((value) =>
    tokenOverlap(query, value) < 0.3 &&
    topicTokenOverlap(query, value) < 0.12
  );
}

function isExplicitAtomicSingleValueQuery(
  query: string,
  understanding?: QueryUnderstandingResult,
): boolean {
  if (
    understanding?.status === 'ambiguous' ||
    understanding?.status === 'unavailable' ||
    (understanding?.unresolvedReferences.length || 0) > 0
  ) return false;
  const variants = [
    query,
    understanding?.standaloneQuery,
    understanding?.rankingQuery,
  ].map((value) => atomicQueryVariant(value || '')).filter(Boolean);
  if (
    variants.length === 0 ||
    variants.some((value) =>
      NON_ATOMIC_SINGLE_VALUE_QUERY_PATTERN.test(cleanText(value)))
  ) return false;
  return variants.every((value) =>
    deterministicAtomicProfileQueryRule(cleanText(value)) !== null ||
    EXPLICIT_ATOMIC_SINGLE_VALUE_QUERY_PATTERN.test(cleanText(value)));
}

function isExplicitExhaustiveRecallQuery(
  query: string,
  understanding?: QueryUnderstandingResult,
): boolean {
  return [
    query,
    understanding?.standaloneQuery,
    understanding?.rankingQuery,
  ].some((value) =>
    EXPLICIT_EXHAUSTIVE_RECALL_QUERY_PATTERN.test(cleanText(value || ''))
  );
}

function isExplicitVerbatimUserEvidenceQuery(
  query: string,
  rankingQuery: string,
): boolean {
  return [query, rankingQuery].some((value) =>
    EXPLICIT_VERBATIM_USER_EVIDENCE_QUERY_PATTERN.test(cleanText(value))
  );
}

function deterministicExactIdentifierCandidate<T extends {
  text: string;
  retrieval: { lexicalRank: number | null };
}>(
  query: string,
  candidates: readonly T[],
): { candidate: T; identifier: string } | null {
  const identifiers = [
    ...new Set(
      (cleanText(query).match(HIGH_ENTROPY_IDENTIFIER_PATTERN) || [])
        .map((value) => value.toLocaleLowerCase())
        .filter((value) => /[A-Za-z]/u.test(value) && /[0-9]/u.test(value)),
    ),
  ].sort((left, right) => right.length - left.length);
  if (identifiers.length === 0 || candidates.length === 0) return null;
  for (const identifier of identifiers) {
    const matched = candidates.filter((candidate) =>
      cleanText(candidate.text).toLocaleLowerCase().includes(identifier));
    if (
      matched.length === 1 &&
      matched[0].retrieval.lexicalRank !== null
    ) {
      return { candidate: matched[0], identifier };
    }
  }
  return null;
}

function approximateTokenCount(value: string): number {
  return Math.max(
    1,
    [...value].filter((character) => !/\s/u.test(character)).length,
  );
}

function truncateToTokenBudget(
  value: string,
  tokenBudget: number,
): string {
  const characters = [...value];
  let used = 0;
  let end = 0;
  while (end < characters.length) {
    const cost = /\s/u.test(characters[end]) ? 0 : 1;
    if (used + cost > Math.max(1, tokenBudget - 1)) break;
    used += cost;
    end += 1;
  }
  return `${characters.slice(0, end).join('').trimEnd()}…`;
}

function cleanUserId(value: string | undefined): string {
  return cleanText(value, config.defaultUserId);
}

function cleanScopeType(
  value: RememberInput['scopeType'] | UpdateMemoryInput['scopeType'],
  fallback: MemoryRecord['scopeType'] = 'personal',
): MemoryRecord['scopeType'] {
  return ['personal', 'project', 'role', 'session', 'public'].includes(
    value || '',
  )
    ? value as MemoryRecord['scopeType']
    : fallback;
}

function cleanSensitivity(
  value: RememberInput['sensitivity'] | UpdateMemoryInput['sensitivity'],
  fallback: MemoryRecord['sensitivity'] = 'normal',
): MemoryRecord['sensitivity'] {
  return ['normal', 'sensitive', 'credential'].includes(value || '')
    ? value as MemoryRecord['sensitivity']
    : fallback;
}

const SOURCE_AUTHORITY_RANK: Record<
  MemoryRecord['sourceAuthority'],
  number
> = {
  legacy_unknown: 0,
  assistant_inference: 1,
  imported: 2,
  user_confirmed: 3,
  direct_user: 4,
};

function cleanSourceAuthority(
  value:
    | RememberInput['sourceAuthority']
    | UpdateMemoryInput['sourceAuthority'],
  fallback: MemoryRecord['sourceAuthority'] = 'legacy_unknown',
): MemoryRecord['sourceAuthority'] {
  return [
    'direct_user',
    'user_confirmed',
    'assistant_inference',
    'imported',
    'legacy_unknown',
  ].includes(value || '')
    ? value as MemoryRecord['sourceAuthority']
    : fallback;
}

function strongerSourceAuthority(
  current: MemoryRecord['sourceAuthority'],
  observed: MemoryRecord['sourceAuthority'],
): MemoryRecord['sourceAuthority'] {
  return SOURCE_AUTHORITY_RANK[observed] >
    SOURCE_AUTHORITY_RANK[current]
    ? observed
    : current;
}

function cleanDate(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined || value.trim() === '') {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} 必须是有效的 ISO 日期时间`);
  }
  return new Date(timestamp).toISOString();
}

function validateValidityWindow(
  validFrom: string | null,
  validTo: string | null,
): void {
  if (
    validFrom &&
    validTo &&
    Date.parse(validFrom) >= Date.parse(validTo)
  ) {
    throw new Error('validFrom 必须早于 validTo');
  }
}

function cleanTags(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values || [])
        .map((value) => cleanText(value).toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 30);
}

function checksum(content: string): string {
  return canonicalContentHash(content);
}

function stableKeyForCreate(
  database: DatabaseSync,
  input: {
    userId: string;
    namespace: string;
    kind: MemoryRecord['kind'];
    requested?: string;
    normalizedValue?: string;
    normalizedValueHash?: string;
    content: string;
  },
): string | undefined {
  const requested = cleanText(input.requested);
  if (!requested) return undefined;
  const existing = database
    .prepare(
      `SELECT status
       FROM memory_items
       WHERE user_id = ? AND namespace = ? AND stable_key = ?`,
    )
    .get(
      input.userId,
      input.namespace,
      requested,
    ) as DatabaseRow | undefined;
  if (asString(existing?.status) !== 'deleted') return requested;
  const valueIdentity =
    cleanText(input.normalizedValueHash) ||
    checksum(cleanText(input.normalizedValue, input.content));
  return [
    requested,
    'post-forget',
    input.kind,
    valueIdentity.slice(0, 24),
  ].join('::');
}

function authorizedTombstoneId(
  database: DatabaseSync,
  claim: TombstoneClaimIdentity,
  authorization?: TombstoneWriteAuthorization,
): string | null {
  const blocking = findBlockingTombstone(database, claim);
  if (!blocking) return null;
  if (
    authorization?.purpose === 'restore-reconciliation' &&
    authorization.tombstoneId === blocking.id
  ) {
    return blocking.id;
  }
  throw new Error(
    `该长期记忆已被遗忘规则阻止（tombstone ${blocking.id}）`,
  );
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function normalizeCorpusDomain(value: unknown): CorpusDomain | null {
  return value === 'policy' || value === 'open' || value === 'chat'
    ? value
    : null;
}

/**
 * 密级归一：非法值一律回落 internal（从严——写坏的字段不能放大可见范围）。
 * 恒返回具体值，与 v43 列默认值 internal 一致。
 */
function normalizeClassification(value: unknown): MemoryClassification {
  return value === 'public' || value === 'confidential'
    ? value
    : 'internal';
}

function rowToMemory(row: DatabaseRow): MemoryRecord {
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    namespace: asString(row.namespace),
    scopeType:
      (asString(row.scope_type) as MemoryRecord['scopeType']) ||
      'personal',
    scopeKey: asString(row.scope_key) || 'self',
    kind: asString(row.kind) as MemoryRecord['kind'],
    title: asString(row.title),
    content: asString(row.content),
    summary: asString(row.summary),
    tags: parseJson<string[]>(row.tags_json, []),
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    sensitivity:
      (asString(row.sensitivity) as MemoryRecord['sensitivity']) ||
      'normal',
    sourceAuthority:
      (asString(
        row.source_authority,
      ) as MemoryRecord['sourceAuthority']) || 'legacy_unknown',
    negated: Number(row.negated) === 1,
    status: asString(row.status) as MemoryRecord['status'],
    source: asString(row.source),
    sourceRef: asNullableString(row.source_ref),
    occurredAt: asNullableString(row.occurred_at),
    validFrom: asNullableString(row.valid_from),
    validTo: asNullableString(row.valid_to),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    lastSeenAt: asString(row.last_seen_at),
    lastAccessedAt: asNullableString(row.last_accessed_at),
    accessCount: Number(row.access_count),
    checksum: asString(row.checksum),
    deletedAt: asNullableString(row.deleted_at),
    origin: row.origin === 'api' ? 'api' : 'pipeline',
    corpusDomain: (['policy', 'open', 'chat'] as const).includes(
      row.corpus_domain as never,
    )
      ? (row.corpus_domain as MemoryRecord['corpusDomain'])
      : undefined,
    classification: normalizeClassification(row.classification),
  };
}

function memoryText(memory: Pick<
  MemoryRecord,
  'title' | 'content' | 'summary' | 'tags'
>): string {
  return [
    memory.title,
    memory.content,
    memory.summary,
    memory.tags.join(' '),
  ].join('\n');
}

function semanticMemoryText(memory: Pick<
  MemoryRecord,
  'title' | 'content' | 'summary' | 'tags'
>): string {
  return [
    ...new Set(
      [
        memory.title,
        memory.content,
        memory.summary,
        memory.tags.join(' '),
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].join('\n');
}

function boundedEvidenceExcerpt(value: string, maximum = 180): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const characters = [...normalized];
  return characters.length <= maximum
    ? normalized
    : `${characters.slice(0, maximum).join('')}…`;
}

// Real qwen2.5:14b measurements cross the 1.5 s gate once a 16-item
// provider batch grows much beyond this payload. Keep this separate from the
// ranker's larger protocol-safety ceiling: this is the production latency
// budget after all evidence text has been appended.
//
// 该预算已改为可配置（config.semanticRerankCandidateTextBudget），出厂 640
// 保持零回归。对话记忆条目短，640 够用；知识库 chunk 数百字时 16 条摊薄到
// 约 40 字/条，答案区不进重排视野——实测把预算放到 2400 后 gold 召回
// 25% → 83%（代价单次重排 1.4s → 4.0s）。放大预算时必须同步设置
// config.semanticRerankNumCtx，否则尾批候选被上下文窗口截断。
const RERANK_PROVIDER_CANDIDATE_LIMIT = 16;
const RERANK_PROVIDER_QUERY_TEXT_BUDGET = 128;

function boundedHeadAndTail(value: string, maximum: number): string {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  if (maximum <= 1) return characters.slice(0, maximum).join('');
  const contentBudget = maximum - 1;
  const headLength = Math.ceil(contentBudget * 0.85);
  return `${characters.slice(0, headLength).join('')}…${
    characters.slice(-(contentBudget - headLength)).join('')
  }`;
}

interface AtomicRerankClaim {
  subject: string;
  predicate: string;
  value: string;
  negated: boolean;
}

function parseAtomicRerankClaim(value: string): AtomicRerankClaim | null {
  const prefix = 'atomic-memory-v1:';
  if (!value.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(value.slice(prefix.length)) as
      Record<string, unknown>;
    if (
      typeof parsed.subject !== 'string' ||
      typeof parsed.predicate !== 'string' ||
      typeof parsed.value !== 'string'
    ) {
      return null;
    }
    return {
      subject: parsed.subject.normalize('NFKC').trim() || '?',
      predicate: parsed.predicate.normalize('NFKC').trim() || '?',
      value: parsed.value.normalize('NFKC').trim(),
      negated: parsed.negated === true,
    };
  } catch {
    return null;
  }
}

function atomicRerankSemanticFloor(claim: AtomicRerankClaim): string {
  return `原子|主体=${[...claim.subject][0] || '?'}|谓词=${
    [...claim.predicate][0] || '?'
  }|否定=${claim.negated ? '是' : '否'}|值=`;
}

function compactAtomicRerankText(claim: AtomicRerankClaim): string {
  return `原子|主体=${claim.subject}|谓词=${claim.predicate}` +
    `|否定=${claim.negated ? '是' : '否'}|值=${claim.value}`;
}

function waterFillLengths(
  lengths: readonly number[],
  minimums: readonly number[],
  totalBudget: number,
): number[] {
  const allocations = lengths.map((length, index) =>
    Math.min(length, Math.max(0, minimums[index] || 0))
  );
  let remaining = totalBudget - allocations.reduce(
    (total, value) => total + value,
    0,
  );
  if (remaining < 0) {
    throw new Error('重排候选总预算无法保留最小语义边界');
  }
  while (remaining > 0) {
    const active = allocations
      .map((allocation, index) => ({ allocation, index }))
      .filter(({ allocation, index }) => allocation < lengths[index]);
    if (active.length === 0) break;
    const fairShare = Math.max(1, Math.floor(remaining / active.length));
    let granted = 0;
    for (const { index } of active) {
      if (remaining <= 0) break;
      const addition = Math.min(
        fairShare,
        lengths[index] - allocations[index],
        remaining,
      );
      allocations[index] += addition;
      remaining -= addition;
      granted += addition;
    }
    if (granted === 0) break;
  }
  return allocations;
}

interface BoundedRerankQuery {
  text: string;
  originalCharacters: number;
  providerCharacters: number;
  truncated: boolean;
}

const RERANK_QUERY_CRITICAL_CLAUSE_PATTERNS = [
  /(?:关键|限定|明确|重点|核心|真正问题)/u,
  /(?:不|没|无|否|停止|取消|避免|排除|不得|不要|不是|并非)/u,
  /(?:最近|今天|昨天|明天|本周|上周|下周|本月|上月|何时|时间|之前|之后)/u,
  /(?:所有|全部|列出|清单|分别|比较|哪个|哪些|多少)/u,
  /(?:什么|怎么|怎样|为什么|是否|能否|有没有|吗|呢|？|\?)/u,
];

function boundedProviderRankingQuery(value: string): BoundedRerankQuery {
  const normalized = cleanText(value).replace(/\s+/gu, ' ');
  const originalCharacters = [...normalized].length;
  if (originalCharacters <= RERANK_PROVIDER_QUERY_TEXT_BUDGET) {
    return {
      text: normalized,
      originalCharacters,
      providerCharacters: originalCharacters,
      truncated: false,
    };
  }
  const clauses = normalized.match(
    /[^，。！？；;,.!?]+[，。！？；;,.!?]?/gu,
  )?.map((clause) => clause.trim()).filter(Boolean) || [normalized];
  const selectedIndexes = new Set<number>([0, clauses.length - 1]);
  const critical = clauses
    .map((clause, index) => ({
      index,
      score: RERANK_QUERY_CRITICAL_CLAUSE_PATTERNS.reduce(
        (score, pattern) => score + (pattern.test(clause) ? 1 : 0),
        0,
      ),
    }))
    .filter(({ index, score }) =>
      index > 0 && index < clauses.length - 1 && score > 0
    )
    .sort((left, right) =>
      right.score - left.score || left.index - right.index
    )
    .slice(0, 2);
  for (const { index } of critical) selectedIndexes.add(index);
  if (selectedIndexes.size < 3 && clauses.length > 2) {
    selectedIndexes.add(Math.floor((clauses.length - 1) / 2));
  }
  const selected = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => clauses[index]);
  const delimiterCharacters = Math.max(0, selected.length - 1);
  const contentBudget =
    RERANK_PROVIDER_QUERY_TEXT_BUDGET - delimiterCharacters;
  const lengths = selected.map((clause) => [...clause].length);
  const allocations = waterFillLengths(
    lengths,
    lengths.map((length) => Math.min(length, 12)),
    contentBudget,
  );
  const text = selected.map((clause, index) =>
    boundedHeadAndTail(clause, allocations[index])
  ).join('…');
  return {
    text,
    originalCharacters,
    providerCharacters: [...text].length,
    truncated: true,
  };
}

function boundedAtomicRerankText(value: string, maximum: number): string {
  const prefix = 'atomic-memory-v1:';
  const claim = parseAtomicRerankClaim(value);
  if (!claim) {
    const episodePrefix = value.match(/^用户原话[：:]\s*/u)?.[0] || '';
    if (episodePrefix) {
      const prefixLength = [...episodePrefix].length;
      return episodePrefix + boundedHeadAndTail(
        value.slice(episodePrefix.length),
        Math.max(0, maximum - prefixLength),
      );
    }
    return boundedHeadAndTail(value, maximum);
  }
  const compact = `${prefix}${JSON.stringify(claim)}`;
  if ([...compact].length <= maximum) return compact;

  const semanticFloor = atomicRerankSemanticFloor(claim);
  if ([...semanticFloor].length > maximum) {
    throw new Error('单条原子记忆预算无法保留 subject/predicate/negated');
  }
  const fixed = `原子|主体=|谓词=|否定=${
    claim.negated ? '是' : '否'
  }|值=`;
  const fieldBudget = maximum - [...fixed].length;
  const subject = [...claim.subject];
  const predicate = [...claim.predicate];
  const identityBudget = Math.min(
    fieldBudget,
    subject.length + predicate.length,
  );
  const identityAllocations = waterFillLengths(
    [subject.length, predicate.length],
    [1, 1],
    identityBudget,
  );
  const valueBudget = Math.max(
    0,
    fieldBudget - identityAllocations[0] - identityAllocations[1],
  );
  return `原子|主体=${
    boundedHeadAndTail(claim.subject, identityAllocations[0])
  }` +
    `|谓词=${boundedHeadAndTail(claim.predicate, identityAllocations[1])}` +
    `|否定=${claim.negated ? '是' : '否'}` +
    `|值=${boundedHeadAndTail(claim.value, valueBudget)}`;
}

function rerankCandidateMinimumBudget(value: string): number {
  const length = [...value].length;
  const atomic = parseAtomicRerankClaim(value);
  if (atomic) {
    return Math.min(length, [...atomicRerankSemanticFloor(atomic)].length);
  }
  const episodePrefix = value.match(/^用户原话[：:]\s*/u)?.[0] || '';
  if (episodePrefix) {
    return Math.min(length, [...episodePrefix].length + 1);
  }
  return Math.min(length, 1);
}

function rerankCandidateDemand(value: string): number {
  const length = [...value].length;
  const atomic = parseAtomicRerankClaim(value);
  return atomic
    ? Math.min(length, [...compactAtomicRerankText(atomic)].length)
    : length;
}

function applyRerankCandidateTextBudget<T extends { memory: string }>(
  candidates: readonly T[],
): T[] {
  if (candidates.length === 0) return [];
  const providerBatchSize = RERANK_PROVIDER_CANDIDATE_LIMIT;
  const bounded: T[] = [];
  for (let start = 0; start < candidates.length; start += providerBatchSize) {
    const providerBatch = candidates.slice(start, start + providerBatchSize);
    const totalCharacters = providerBatch.reduce(
      (total, candidate) => total + [...candidate.memory].length,
      0,
    );
    if (totalCharacters <= config.semanticRerankCandidateTextBudget) {
      bounded.push(...providerBatch);
      continue;
    }
    const candidateLengths = providerBatch.map((candidate) =>
      rerankCandidateDemand(candidate.memory)
    );
    const allocations = waterFillLengths(
      candidateLengths,
      providerBatch.map((candidate) =>
        rerankCandidateMinimumBudget(candidate.memory)
      ),
      config.semanticRerankCandidateTextBudget,
    );
    bounded.push(...providerBatch.map((candidate, index) => ({
      ...candidate,
      memory: boundedAtomicRerankText(
        candidate.memory,
        allocations[index],
      ),
    })));
  }
  return bounded;
}

const evidenceDigestSqlFunctionDatabases = new WeakSet<DatabaseSync>();

function ensureEvidenceDigestSqlFunctions(database: DatabaseSync): void {
  if (evidenceDigestSqlFunctionDatabases.has(database)) return;
  database.function(
    'memory_bridge_bounded_evidence_excerpt_v1',
    { deterministic: true, directOnly: true },
    (value) => boundedEvidenceExcerpt(
      typeof value === 'string' ? value : '',
    ),
  );
  database.function(
    'memory_bridge_trim_evidence_excerpt_v1',
    { deterministic: true, directOnly: true },
    (value) => typeof value === 'string' ? value.trim() : '',
  );
  database.function(
    'memory_bridge_evidence_excerpt_is_safe_v1',
    { deterministic: true, directOnly: true },
    (value) => containsCredentialSecret(
      typeof value === 'string' ? value : '',
    ) ? 0 : 1,
  );
  evidenceDigestSqlFunctionDatabases.add(database);
}

function evidenceDigestText(
  digest: MemoryEvidenceDigest | undefined,
): string {
  if (!digest?.versionId) return '';
  const lines = [`当前版本独立用户证据 ${digest.proofCount} 条`];
  if (digest.firstEvidenceAt || digest.lastEvidenceAt) {
    lines.push(
      `证据时间: ${digest.firstEvidenceAt || digest.lastEvidenceAt}` +
        (digest.firstEvidenceAt && digest.lastEvidenceAt &&
            digest.firstEvidenceAt !== digest.lastEvidenceAt
          ? ` 至 ${digest.lastEvidenceAt}`
          : ''),
    );
  }
  const excerpt = digest.excerpts[0];
  if (excerpt) {
    lines.push(`用户原文证据: ${boundedEvidenceExcerpt(excerpt, 120)}`);
  }
  return lines.join('\n');
}

function stripUntrustedRerankControlLines(value: string): string {
  return value
    .split(/\r?\n/u)
    .filter((line) => {
      const normalized = line.normalize('NFKC').trim();
      return !normalized.startsWith('atomic-memory-v1:') &&
        !/^(?:用户原话|用户说)[：:]/u.test(normalized);
    })
    .join('\n')
    .trim();
}

function trustedDigestUserEvidenceText(
  digest: MemoryEvidenceDigest | undefined,
): string {
  if (
    !digest?.versionId ||
    digest.proofCount <= 0 ||
    digest.excerpts.length === 0
  ) return '';
  return digest.excerpts
    .slice(0, 1)
    .map((value) => `用户原话: ${boundedEvidenceExcerpt(value, 180)}`)
    .join('\n');
}

function semanticRerankText(
  memory: MemoryRecord,
  digest: MemoryEvidenceDigest | undefined,
  includeVerbatimUserEvidence: boolean,
): string {
  const trustedCurrentVersion = Boolean(digest?.versionId) &&
    ['direct_user', 'user_confirmed'].includes(memory.sourceAuthority);
  const verifiedUserEvidence = trustedDigestUserEvidenceText(digest);
  const atomic = trustedCurrentVersion
    ? memory.content
        .split(/\r?\n/u)
        .find((line) => line.startsWith('atomic-memory-v1:'))
    : undefined;
  const directUserEvidence = trustedCurrentVersion
    ? verifiedUserEvidence
    : '';
  if (memory.source === 'conversation_episode') {
    return verifiedUserEvidence;
  }
  if (atomic) {
    return includeVerbatimUserEvidence && directUserEvidence
      ? directUserEvidence
      : atomic;
  }
  const memoryTextValue = atomic || directUserEvidence || [
    memory.content,
    memory.summary,
    memory.title,
  ]
    .map(stripUntrustedRerankControlLines)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join('\n');
  const boundedMemoryText = boundedEvidenceExcerpt(memoryTextValue, 360);
  const digestText = evidenceDigestText(digest);
  if (directUserEvidence) return directUserEvidence;
  return digestText
    ? `${boundedMemoryText}\n${digestText}`
    : boundedMemoryText;
}

function semanticCandidateEvidence(
  memory: MemoryRecord,
  digest: MemoryEvidenceDigest | undefined,
): NonNullable<SemanticCandidate['evidence']> {
  const verifiedEpisodeUserEvidence =
    memory.source === 'conversation_episode' &&
    trustedDigestUserEvidenceText(digest).length > 0;
  const authority = verifiedEpisodeUserEvidence
    ? 'direct_user'
    : memory.sourceAuthority === 'direct_user' ||
      memory.sourceAuthority === 'user_confirmed'
    ? memory.sourceAuthority
    : memory.sourceAuthority === 'assistant_inference'
    ? 'assistant'
    : memory.sourceAuthority === 'imported'
    ? 'imported'
    : 'unknown';
  const active = memory.status === 'active' && !memory.deletedAt;
  return {
    authority,
    currentVersion: Boolean(digest?.versionId),
    active,
    scopeAuthorized: true,
    revoked: !active,
    forgotten: memory.status === 'deleted' || Boolean(memory.deletedAt),
    occurredAt: memory.occurredAt,
    eventType: null,
    entities: [],
  };
}

function semanticTextHash(value: string): string {
  return createHash('sha256')
    .update(value.normalize('NFKC'))
    .digest('hex');
}

function denseGenerationKey(vector: Float32Array): string {
  return createHash('sha256')
    .update(vectorToBuffer(vector))
    .digest('hex');
}

function defaultTitle(content: string): string {
  const firstLine = content.split(/\r?\n/)[0].trim();
  return firstLine.slice(0, 60) || '未命名记忆';
}

function isValidKind(value: string): value is MemoryRecord['kind'] {
  return MEMORY_KINDS.includes(value as MemoryRecord['kind']);
}

function recencyScore(updatedAt: string): number {
  const ageMs = Math.max(0, Date.now() - new Date(updatedAt).getTime());
  const ageDays = ageMs / 86_400_000;
  return Math.exp(-ageDays / 180);
}

const TEMPORAL_DAY_MS = 86_400_000;
const TEMPORAL_QUERY_PATTERNS: ReadonlyArray<{
  kind: TemporalRetrievalKind;
  label: string;
  pattern: RegExp;
}> = [
  {
    kind: 'history_sequence',
    label: '前后多次',
    pattern: /(?:(?:前后|先后).{0,6}(?:两|二|2)次|(?:两|二|2)次.{0,8}(?:分别|各自))/u,
  },
  { kind: 'yesterday', label: '昨天', pattern: /(?:昨天|昨日|yesterday)/iu },
  { kind: 'tomorrow', label: '明天', pattern: /(?:明天|明日|tomorrow)/iu },
  { kind: 'last_week', label: '上周', pattern: /(?:上一?周|上星期|last\s+week)/iu },
  { kind: 'next_week', label: '下周', pattern: /(?:下一?周|下星期|next\s+week)/iu },
  { kind: 'this_week', label: '本周', pattern: /(?:本周|这周|这一周|this\s+week)/iu },
  { kind: 'last_month', label: '上个月', pattern: /(?:上个月|上月|last\s+month)/iu },
  { kind: 'this_month', label: '本月', pattern: /(?:本月|这个月|this\s+month)/iu },
  { kind: 'today', label: '今天', pattern: /(?:今天|今日|today)/iu },
  {
    kind: 'recent',
    label: '最近',
    pattern: /(?:最近|近期|近来|新近|最新|刚刚|刚才|这几天|recent(?:ly)?|latest|lately)/iu,
  },
];

function localDayStart(
  timestampMs: number,
  timezoneOffsetMinutes: number,
): number {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  return Math.floor((timestampMs + offsetMs) / TEMPORAL_DAY_MS) *
      TEMPORAL_DAY_MS - offsetMs;
}

function localWeekStart(
  timestampMs: number,
  timezoneOffsetMinutes: number,
): number {
  const dayStart = localDayStart(timestampMs, timezoneOffsetMinutes);
  const localDay = new Date(
    dayStart + timezoneOffsetMinutes * 60_000,
  ).getUTCDay();
  const daysSinceMonday = (localDay + 6) % 7;
  return dayStart - daysSinceMonday * TEMPORAL_DAY_MS;
}

function localMonthStart(
  timestampMs: number,
  timezoneOffsetMinutes: number,
  monthDelta = 0,
): number {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const local = new Date(timestampMs + offsetMs);
  return Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth() + monthDelta,
    1,
  ) - offsetMs;
}

function temporalRetrievalPlan(
  query: string,
  understanding: QueryUnderstandingResult | undefined,
  referenceAt: string,
): TemporalRetrievalPlan | null {
  const referenceMs = Date.parse(referenceAt);
  if (!Number.isFinite(referenceMs)) return null;
  const sources = [
    understanding?.rankingQuery,
    understanding?.standaloneQuery,
    query,
    ...(understanding?.constraints.temporal || []),
  ].map((value) => cleanText(value || '')).filter(Boolean);
  const matches = TEMPORAL_QUERY_PATTERNS.filter(({ pattern }) =>
    sources.some((source) => pattern.test(source))
  );
  const distinctKinds = [...new Set(matches.map(({ kind }) => kind))];
  if (distinctKinds.length !== 1) return null;
  const match = matches.find(({ kind }) => kind === distinctKinds[0]);
  if (!match) return null;
  const timezoneOffsetMinutes = config.summaryTimezoneOffsetMinutes;
  const dayStart = localDayStart(referenceMs, timezoneOffsetMinutes);
  const weekStart = localWeekStart(referenceMs, timezoneOffsetMinutes);
  const monthStart = localMonthStart(referenceMs, timezoneOffsetMinutes);
  let rangeStartMs: number | null = null;
  let rangeEndMs: number | null = null;
  switch (match.kind) {
    case 'history_sequence':
      break;
    case 'today':
      rangeStartMs = dayStart;
      rangeEndMs = dayStart + TEMPORAL_DAY_MS;
      break;
    case 'yesterday':
      rangeStartMs = dayStart - TEMPORAL_DAY_MS;
      rangeEndMs = dayStart;
      break;
    case 'tomorrow':
      rangeStartMs = dayStart + TEMPORAL_DAY_MS;
      rangeEndMs = dayStart + 2 * TEMPORAL_DAY_MS;
      break;
    case 'this_week':
      rangeStartMs = weekStart;
      rangeEndMs = weekStart + 7 * TEMPORAL_DAY_MS;
      break;
    case 'last_week':
      rangeStartMs = weekStart - 7 * TEMPORAL_DAY_MS;
      rangeEndMs = weekStart;
      break;
    case 'next_week':
      rangeStartMs = weekStart + 7 * TEMPORAL_DAY_MS;
      rangeEndMs = weekStart + 14 * TEMPORAL_DAY_MS;
      break;
    case 'this_month':
      rangeStartMs = monthStart;
      rangeEndMs = localMonthStart(
        referenceMs,
        timezoneOffsetMinutes,
        1,
      );
      break;
    case 'last_month':
      rangeStartMs = localMonthStart(
        referenceMs,
        timezoneOffsetMinutes,
        -1,
      );
      rangeEndMs = monthStart;
      break;
    case 'recent':
      break;
  }
  return {
    kind: match.kind,
    label: match.label,
    referenceAt,
    rangeStartMs,
    rangeEndMs,
  };
}

function temporalCandidateSignal(
  plan: TemporalRetrievalPlan | null,
  memory: MemoryRecord,
  digest: MemoryEvidenceDigest | undefined,
): TemporalCandidateSignal | null {
  if (!plan) return null;
  const anchors: Array<[
    string | null | undefined,
    TemporalCandidateSignal['anchorSource'],
  ]> = plan.kind === 'history_sequence'
    ? [
        [memory.occurredAt, 'occurred_at'],
        [digest?.lastEvidenceAt, 'trusted_user_evidence'],
        [memory.lastSeenAt, 'last_seen_at'],
        [memory.updatedAt, 'updated_at'],
      ]
    : [
        [digest?.lastEvidenceAt, 'trusted_user_evidence'],
        [memory.occurredAt, 'occurred_at'],
        [memory.lastSeenAt, 'last_seen_at'],
        [memory.updatedAt, 'updated_at'],
      ];
  for (const [anchorAt, anchorSource] of anchors) {
    if (!anchorAt) continue;
    const anchorMs = Date.parse(anchorAt);
    if (!Number.isFinite(anchorMs)) continue;
    let score: number;
    if (plan.kind === 'history_sequence') {
      score = 1;
    } else if (plan.rangeStartMs !== null && plan.rangeEndMs !== null) {
      const distanceMs = anchorMs < plan.rangeStartMs
        ? plan.rangeStartMs - anchorMs
        : anchorMs >= plan.rangeEndMs
          ? anchorMs - plan.rangeEndMs
          : 0;
      score = distanceMs === 0
        ? 1
        : Math.exp(-distanceMs / (14 * TEMPORAL_DAY_MS));
    } else {
      const referenceMs = Date.parse(plan.referenceAt);
      const ageMs = Math.max(0, referenceMs - anchorMs);
      score = Math.exp(-ageMs / (30 * TEMPORAL_DAY_MS));
    }
    return {
      score: Math.max(0, Math.min(1, score)),
      anchorAt,
      anchorSource,
    };
  }
  return null;
}

function temporalReason(
  plan: TemporalRetrievalPlan,
  signal: TemporalCandidateSignal,
): string {
  const source = signal.anchorSource === 'trusted_user_evidence'
    ? '当前版本用户证据时间'
    : signal.anchorSource === 'occurred_at'
      ? '事件发生时间'
      : signal.anchorSource === 'last_seen_at'
        ? '最近观察时间'
        : '记忆更新时间';
  return `时间意图“${plan.label}”参考${source}`;
}

function orderTemporalResults(
  plan: TemporalRetrievalPlan | null,
  results: RecallResult[],
): RecallResult[] {
  if (plan?.kind !== 'history_sequence') return results;
  return [...results].sort((left, right) => {
    const leftAt = Date.parse(
      left.memory.occurredAt ||
        left.memory.lastSeenAt ||
        left.memory.updatedAt,
    );
    const rightAt = Date.parse(
      right.memory.occurredAt ||
        right.memory.lastSeenAt ||
        right.memory.updatedAt,
    );
    const chronological = leftAt - rightAt;
    return chronological || left.memory.id.localeCompare(right.memory.id);
  });
}

function conflictState(
  status: MemoryRecord['status'],
): RecallResult['explanation']['conflictState'] {
  if (status === 'superseded') return 'superseded';
  if (status === 'archived') return 'archived';
  return 'none';
}

const SCOPE_PRECEDENCE: Record<
  MemoryRecord['scopeType'],
  number
> = {
  personal: 0,
  project: 1,
  role: 2,
  session: 3,
  // public 文档在冲突裁决中优先级最低（最通用、最不"个人"的来源）。
  public: 4,
};

function memorySimilarity(
  left: MemoryRecord,
  right: MemoryRecord,
): number {
  const leftText = memoryText(left);
  const rightText = memoryText(right);
  return Math.max(
    tokenOverlap(leftText, rightText),
    cosineSimilarity(embedText(leftText), embedText(rightText)),
  );
}

function selectDiverseResults(
  ranked: RecallResult[],
  limit: number,
): RecallResult[] {
  const remaining = [...ranked];
  const selected: RecallResult[] = [];
  const relevanceWeight = 0.78;
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;
    let bestPenalty = 0;
    for (const [index, candidate] of remaining.entries()) {
      const maximumSimilarity = selected.reduce(
        (maximum, existing) =>
          Math.max(
            maximum,
            memorySimilarity(candidate.memory, existing.memory),
          ),
        0,
      );
      const diversityPenalty =
        (1 - relevanceWeight) * maximumSimilarity;
      const mmr =
        relevanceWeight * candidate.score - diversityPenalty;
      const best = remaining[bestIndex];
      if (
        mmr > bestMmr ||
        (
          mmr === bestMmr &&
          (
            candidate.score > best.score ||
            (
              candidate.score === best.score &&
              candidate.memory.id.localeCompare(best.memory.id) < 0
            )
          )
        )
      ) {
        bestIndex = index;
        bestMmr = mmr;
        bestPenalty = diversityPenalty;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    const roundedPenalty = Number(bestPenalty.toFixed(4));
    selected.push({
      ...chosen,
      reasons: roundedPenalty > 0
        ? [
            ...chosen.reasons,
            `MMR 多样性惩罚 ${roundedPenalty.toFixed(2)}`,
          ]
        : [...chosen.reasons],
      explanation: {
        ...chosen.explanation,
        diversityPenalty: roundedPenalty,
      },
    });
  }
  return selected;
}

function validateBackup(
  payload: unknown,
  targetUserId: string,
): MemoryBackup {
  if (
    payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Number((payload as Record<string, unknown>).schemaVersion) >= 37
  ) {
    const state = (payload as Record<string, unknown>).state;
    const requiredLayeredFields = [
      'episodes',
      'episodeTurns',
      'patternObservations',
      'hierarchicalSummaries',
      'hierarchicalSummarySources',
    ];
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('schema 37 完整备份缺少分层记忆 state');
    }
    for (const field of requiredLayeredFields) {
      if (!Object.prototype.hasOwnProperty.call(state, field)) {
        throw new Error(`schema 37 完整备份缺少分层记忆字段 ${field}`);
      }
    }
  }
  const parsed = memoryBackupSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`备份格式无效：${parsed.error.issues[0]?.message || '未知错误'}`);
  }
  const backup = parsed.data;
  if (backup.userId !== targetUserId) {
    throw new Error(
      `备份用户 ${backup.userId} 与当前用户 ${targetUserId} 不一致`,
    );
  }

  if (
    (backup.version === 2 || (backup.schemaVersion || 0) < 26) &&
    legacyBackupContainsProjectScope(backup)
  ) {
    throw new Error(
      '旧版完整备份包含无法证明归属的 project scope；请先隔离（quarantine）并显式重绑（rebind）',
    );
  }
  if (
    backup.version === 2 &&
    backup.memories.some(
      (memory) =>
        memory.scopeType !== 'personal' || memory.scopeKey !== 'self',
    )
  ) {
    throw new Error(
      'v2 完整备份的 role/session 或非 personal/self scope 缺少可信会话；请先隔离（quarantine）并显式重绑（rebind）',
    );
  }

  const memoryIds = new Set<string>();
  for (const memory of backup.memories) {
    if (memory.userId !== targetUserId) {
      throw new Error(`记忆 ${memory.id} 不属于备份用户`);
    }
    if (memoryIds.has(memory.id)) {
      throw new Error(`备份包含重复记忆 ID：${memory.id}`);
    }
    memoryIds.add(memory.id);
    if (memory.checksum !== checksum(memory.content)) {
      throw new Error(`记忆 ${memory.id} 的校验和不匹配`);
    }
    validateValidityWindow(memory.validFrom, memory.validTo);
    if (
      (memory.status === 'deleted' && !memory.deletedAt) ||
      (memory.status !== 'deleted' && memory.deletedAt)
    ) {
      throw new Error(`记忆 ${memory.id} 的删除状态与删除时间不一致`);
    }
  }

  const relationKeys = new Set<string>();
  for (const relation of backup.relations) {
    if (
      !memoryIds.has(relation.fromMemoryId) ||
      !memoryIds.has(relation.toMemoryId)
    ) {
      throw new Error('备份关系引用了不存在的记忆');
    }
    const key = [
      relation.fromMemoryId,
      relation.toMemoryId,
      relation.relationType,
    ].join('\u0000');
    if (relationKeys.has(key)) {
      throw new Error('备份包含重复记忆关系');
    }
    relationKeys.add(key);
  }

  const idempotencyKeys = new Set<string>();
  for (const entry of backup.idempotencyKeys) {
    if (entry.userId !== targetUserId) {
      throw new Error('幂等键不属于备份用户');
    }
    if (!memoryIds.has(entry.memoryId)) {
      throw new Error('幂等键引用了不存在的记忆');
    }
    // v43：唯一性含 scope 维度；旧格式备份（无 scope 字段）按 personal/self。
    const key = [
      entry.userId,
      entry.namespace,
      entry.scopeType ?? 'personal',
      entry.scopeKey ?? 'self',
      entry.key,
    ].join('\u0000');
    if (idempotencyKeys.has(key)) {
      throw new Error('备份包含重复幂等键');
    }
    idempotencyKeys.add(key);
  }

  const auditIds = new Set<number>();
  for (const audit of backup.auditLog) {
    if (audit.userId !== targetUserId) {
      throw new Error('审计记录不属于备份用户');
    }
    if (audit.memoryId && !memoryIds.has(audit.memoryId)) {
      throw new Error('审计记录引用了不存在的记忆');
    }
    if (auditIds.has(audit.id)) {
      throw new Error(`备份包含重复审计 ID：${audit.id}`);
    }
    auditIds.add(audit.id);
  }

  if (backup.version === 3) {
    if ((backup.schemaVersion || 0) < 25) {
      hydrateLegacyOutboxScope(backup.state!);
      hydrateLegacySessionIdentityBindings(backup.state!);
    }
    if (
      (backup.schemaVersion || 0) >= 25 &&
      (backup.schemaVersion || 0) < 26
    ) {
      hydrateLegacySessionProjectBindings(backup.state!);
    }
    validateFullBackupState(
      backup.state!,
      targetUserId,
      backup.memories,
    );
    validateReflectionBackupState(
      backup.state!,
      targetUserId,
      (backup.schemaVersion || 0) >= 30,
    );
  }

  return backup;
}

function rowText(
  row: Record<string, string | number | null>,
  column: string,
): string {
  const value = row[column];
  return typeof value === 'string' ? value : String(value ?? '');
}

function optionalRowText(
  row: Record<string, string | number | null>,
  column: string,
): string | null {
  const value = row[column];
  return value === null || value === undefined
    ? null
    : String(value);
}

type FullBackupRow = FullBackupState['turns'][number];

interface FullBackupLookup {
  sessions: Map<string, FullBackupRow>;
  turns: Map<string, FullBackupRow>;
  extractionRuns: Map<string, FullBackupRow>;
  candidates: Map<string, FullBackupRow>;
  items: Map<string, FullBackupRow>;
  versions: Map<string, FullBackupRow>;
  events: Map<string, FullBackupRow>;
  episodes: Map<string, FullBackupRow>;
  hierarchicalSummaries: Map<string, FullBackupRow>;
}

function indexFullBackupRows(
  rows: FullBackupRow[],
): Map<string, FullBackupRow> {
  return new Map(
    rows.map((row) => [rowText(row, 'id'), row]),
  );
}

function createFullBackupLookup(
  state: FullBackupState,
): FullBackupLookup {
  return {
    sessions: indexFullBackupRows(state.sessions),
    turns: indexFullBackupRows(state.turns),
    extractionRuns: indexFullBackupRows(state.extractionRuns),
    candidates: indexFullBackupRows(state.candidates),
    items: indexFullBackupRows(state.items),
    versions: indexFullBackupRows(state.versions),
    events: indexFullBackupRows(state.events),
    episodes: indexFullBackupRows(state.episodes),
    hierarchicalSummaries: indexFullBackupRows(
      state.hierarchicalSummaries,
    ),
  };
}

function parsedBackupJsonDeclaresProjectScope(
  value: unknown,
): boolean {
  if (Array.isArray(value)) {
    return value.some(parsedBackupJsonDeclaresProjectScope);
  }
  if (!value || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replace(/[_-]/gu, '').toLowerCase();
    if (
      (normalizedKey === 'scopetype' ||
        normalizedKey === 'accessscopetype') &&
      nested === 'project'
    ) {
      return true;
    }
    if (parsedBackupJsonDeclaresProjectScope(nested)) return true;
  }
  return false;
}

function fullBackupJsonScopes(
  value: unknown,
  allowConsolidationGroupingScope = false,
): FullBackupAccessScope[] {
  if (Array.isArray(value)) {
    return value.flatMap((nested) =>
      fullBackupJsonScopes(
        nested,
        allowConsolidationGroupingScope,
      ),
    );
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const scopes: FullBackupAccessScope[] = [];
  const hasExplicitAccessScope =
    typeof record.accessScopeType === 'string' ||
    typeof record.access_scope_type === 'string';
  for (const [typeKey, keyKey] of [
    ['scopeType', 'scopeKey'],
    ['scope_type', 'scope_key'],
    ['accessScopeType', 'accessScopeKey'],
    ['access_scope_type', 'access_scope_key'],
  ] as const) {
    if (
      allowConsolidationGroupingScope &&
      hasExplicitAccessScope &&
      (typeKey === 'scopeType' || typeKey === 'scope_type')
    ) {
      continue;
    }
    const scopeType = record[typeKey];
    if (Object.prototype.hasOwnProperty.call(record, typeKey)) {
      scopes.push({
        scopeType: typeof scopeType === 'string' ? scopeType : '',
        scopeKey:
          typeof record[keyKey] === 'string'
            ? record[keyKey]
            : '',
      });
    }
  }
  for (const nested of Object.values(record)) {
    scopes.push(...fullBackupJsonScopes(
      nested,
      allowConsolidationGroupingScope,
    ));
  }
  return scopes;
}

function backupRowDeclaresProjectScope(row: FullBackupRow): boolean {
  if (rowText(row, 'scope_type') === 'project') return true;
  for (const [column, value] of Object.entries(row)) {
    if (
      !column.endsWith('_json') ||
      typeof value !== 'string' ||
      !value.trim()
    ) {
      continue;
    }
    try {
      if (parsedBackupJsonDeclaresProjectScope(JSON.parse(value))) {
        return true;
      }
    } catch {
      // JSON validity is checked by the owning table or insert path.
    }
  }
  return false;
}

function legacyBackupContainsProjectScope(
  backup: MemoryBackup,
): boolean {
  if (backup.memories.some((memory) => memory.scopeType === 'project')) {
    return true;
  }
  if (backup.version !== 3 || !backup.state) return false;
  return Object.values(backup.state).some((rows) =>
    rows.some(backupRowDeclaresProjectScope),
  );
}

function fullBackupAggregateScope(
  lookup: FullBackupLookup,
  aggregateType: string,
  aggregateId: string,
): {
  row: FullBackupRow;
  userId: string;
  namespace: string;
} | null {
  if (aggregateType === 'turn') {
    const row = lookup.turns.get(aggregateId);
    return row
      ? {
          row,
          userId: rowText(row, 'user_id'),
          namespace: rowText(row, 'namespace'),
        }
      : null;
  }
  if (aggregateType === 'memory_candidate') {
    const row = lookup.candidates.get(aggregateId);
    return row
      ? {
          row,
          userId: rowText(row, 'user_id'),
          namespace: rowText(row, 'namespace'),
        }
      : null;
  }
  if (aggregateType === 'memory_event') {
    const row = lookup.events.get(aggregateId);
    const memoryItemId = row
      ? optionalRowText(row, 'memory_item_id')
      : null;
    const item = memoryItemId
      ? lookup.items.get(memoryItemId)
      : undefined;
    return row && item
      ? {
          row,
          userId: rowText(row, 'user_id'),
          namespace: rowText(item, 'namespace'),
        }
      : null;
  }
  return null;
}

function hydrateLegacyOutboxScope(
  state: FullBackupState,
): void {
  const lookup = createFullBackupLookup(state);
  for (const row of state.outbox) {
    const scope = fullBackupAggregateScope(
      lookup,
      rowText(row, 'aggregate_type'),
      rowText(row, 'aggregate_id'),
    );
    if (!scope) continue;
    if (!rowText(row, 'user_id')) {
      row.user_id = scope.userId;
    }
    if (!rowText(row, 'namespace')) {
      row.namespace = scope.namespace;
    }
  }
}

function hydrateLegacySessionProjectBindings(
  state: FullBackupState,
): void {
  for (const row of state.sessions) {
    // schema < 26 never had an authoritative project column. Even if a
    // crafted legacy backup carries that key, it must not be promoted.
    row.project_id = null;
  }
}

function hydrateLegacySessionIdentityBindings(
  state: FullBackupState,
): void {
  for (const row of state.sessions) {
    // schema < 25 did not persist trusted runtime identity. Treat every
    // identity-looking JSON field as untrusted compatibility data.
    row.persona_id = null;
    row.project_id = null;
    row.identity_source = 'legacy';
    row.identity_status = 'legacy';
  }
}

function parseFullBackupJsonObject(
  raw: string,
  label: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The common error below deliberately avoids exposing payload content.
  }
  throw new Error(`${label} 不是 JSON 对象`);
}

function parseFullBackupOutboxPayload(
  row: FullBackupRow,
): Record<string, unknown> {
  return parseFullBackupJsonObject(
    rowText(row, 'payload_json'),
    '完整备份的 outbox payload',
  );
}

function assertSubset(
  values: Iterable<string | null>,
  allowed: Set<string>,
  message: string,
): void {
  for (const value of values) {
    if (value !== null && !allowed.has(value)) {
      throw new Error(message);
    }
  }
}

interface FullBackupAccessScope {
  scopeType: string;
  scopeKey: string;
}

const FULL_BACKUP_ACCESS_SCOPE_TYPES = new Set([
  'personal',
  'project',
  'role',
  'session',
]);

function fullBackupRowScope(
  row: FullBackupRow,
): FullBackupAccessScope {
  const scopeType = rowText(row, 'scope_type') || 'personal';
  return {
    scopeType,
    scopeKey:
      rowText(row, 'scope_key') ||
      (scopeType === 'personal' ? 'self' : ''),
  };
}

function fullBackupMemoryScope(
  memory: MemoryBackup['memories'][number],
): FullBackupAccessScope {
  return {
    scopeType: memory.scopeType,
    scopeKey: memory.scopeKey,
  };
}

function fullBackupScopesEqual(
  left: FullBackupAccessScope,
  right: FullBackupAccessScope,
): boolean {
  return left.scopeType === right.scopeType &&
    left.scopeKey === right.scopeKey;
}

function fullBackupTurnSession(
  lookup: FullBackupLookup,
  turn: FullBackupRow,
  label: string,
): FullBackupRow {
  const session = lookup.sessions.get(rowText(turn, 'session_id'));
  if (!session) {
    throw new Error(`${label} 引用了不存在的会话`);
  }
  if (
    rowText(turn, 'user_id') !== rowText(session, 'user_id') ||
    rowText(turn, 'namespace') !== rowText(session, 'namespace')
  ) {
    throw new Error(`${label} 与会话账户或 namespace 不一致`);
  }
  return session;
}

function assertFullBackupScopeAuthorizedBySession(
  label: string,
  scope: FullBackupAccessScope,
  session: FullBackupRow,
): void {
  if (scope.scopeType === 'personal') {
    if (scope.scopeKey !== 'self') {
      throw new Error(`${label} 的 personal scope 无效`);
    }
    return;
  }
  if (scope.scopeType === 'project') {
    if (
      rowText(session, 'identity_status') !== 'complete' ||
      optionalRowText(session, 'project_id') !== scope.scopeKey
    ) {
      throw new Error(
        `${label} project scope 与原始会话绑定不一致`,
      );
    }
    return;
  }
  if (scope.scopeType === 'role') {
    if (
      rowText(session, 'identity_status') !== 'complete' ||
      optionalRowText(session, 'persona_id') !== scope.scopeKey
    ) {
      throw new Error(
        `${label} role scope 与原始会话绑定不一致`,
      );
    }
    return;
  }
  if (scope.scopeType === 'session') {
    if (
      rowText(session, 'identity_status') !== 'complete' ||
      rowText(session, 'external_id') !== scope.scopeKey
    ) {
      throw new Error(
        `${label} session scope 与原始会话绑定不一致`,
      );
    }
    return;
  }
  throw new Error(`${label} 包含无效 scope`);
}

function assertFullBackupScopeHasIdentitySession(
  label: string,
  scope: FullBackupAccessScope,
  sessions: FullBackupRow[],
  userId: string,
  namespace: string,
): void {
  if (scope.scopeType === 'personal') {
    if (scope.scopeKey !== 'self') {
      throw new Error(`${label} 的 personal scope 无效`);
    }
    return;
  }
  if (!FULL_BACKUP_ACCESS_SCOPE_TYPES.has(scope.scopeType)) {
    throw new Error(`${label} 包含无效 scope`);
  }
  if (!scope.scopeKey) {
    throw new Error(`${label} 的 ${scope.scopeType} scope 缺少 key`);
  }
  const matchingSessions = sessions.filter(
    (session) =>
      rowText(session, 'identity_status') === 'complete' &&
      rowText(session, 'user_id') === userId &&
      rowText(session, 'namespace') === namespace,
  );
  if (scope.scopeType === 'project') {
    const found = matchingSessions.some(
      (session) =>
        optionalRowText(session, 'project_id') === scope.scopeKey,
    );
    if (!found) {
      throw new Error(`${label} project scope 缺少可信会话绑定`);
    }
  }
  if (scope.scopeType === 'role') {
    const found = matchingSessions.some(
      (session) =>
        optionalRowText(session, 'persona_id') === scope.scopeKey,
    );
    if (!found) {
      throw new Error(`${label} role scope 缺少可信会话绑定`);
    }
  }
  if (scope.scopeType === 'session') {
    const found = matchingSessions.some(
      (session) =>
        rowText(session, 'id') === scope.scopeKey ||
        rowText(session, 'external_id') === scope.scopeKey,
    );
    if (!found) {
      throw new Error(`${label} session scope 缺少可信会话绑定`);
    }
  }
}

function assertFullBackupJsonScopesAuthorized(
  label: string,
  value: unknown,
  sessions: FullBackupRow[],
  userId: string,
  namespace: string,
  session?: FullBackupRow,
  allowConsolidationGroupingScope = false,
): void {
  for (const scope of fullBackupJsonScopes(
    value,
    allowConsolidationGroupingScope,
  )) {
    if (!FULL_BACKUP_ACCESS_SCOPE_TYPES.has(scope.scopeType)) {
      if (scope.scopeType === 'topic' || scope.scopeType === 'person') {
        continue;
      }
      throw new Error(`${label} 包含无效 scope`);
    }
    if (session) {
      assertFullBackupScopeAuthorizedBySession(label, scope, session);
      continue;
    }
    assertFullBackupScopeHasIdentitySession(
      label,
      scope,
      sessions,
      userId,
      namespace,
    );
  }
}

function fullBackupConsolidationScopes(
  row: FullBackupRow,
): {
  accessScope: FullBackupAccessScope;
  groupingSessionScope: FullBackupAccessScope | null;
} {
  const scopeType = rowText(row, 'scope_type');
  const storedKey = rowText(row, 'scope_key');
  if (!['session', 'topic', 'person', 'project'].includes(scopeType)) {
    throw new Error('完整备份的派生摘要包含无效 scope');
  }
  if (!storedKey) {
    throw new Error('完整备份的派生摘要缺少 scope key');
  }
  const prefix = 'access-v1:';
  if (storedKey.startsWith(prefix)) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        Buffer.from(
          storedKey.slice(prefix.length),
          'base64url',
        ).toString('utf8'),
      ) as unknown;
    } catch {
      throw new Error('完整备份的派生摘要 access scope 格式无效');
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 3 ||
      !decoded.every((value) => typeof value === 'string') ||
      !FULL_BACKUP_ACCESS_SCOPE_TYPES.has(decoded[0]) ||
      !decoded[1] ||
      !decoded[2]
    ) {
      throw new Error('完整备份的派生摘要 access scope 格式无效');
    }
    return {
      accessScope: {
        scopeType: decoded[0],
        scopeKey: decoded[1],
      },
      groupingSessionScope: scopeType === 'session'
        ? { scopeType: 'session', scopeKey: decoded[2] }
        : null,
    };
  }
  if (scopeType === 'project') {
    return {
      accessScope: { scopeType: 'project', scopeKey: storedKey },
      groupingSessionScope: null,
    };
  }
  return {
    accessScope: { scopeType: 'personal', scopeKey: 'self' },
    groupingSessionScope: scopeType === 'session'
      ? { scopeType: 'session', scopeKey: storedKey }
      : null,
  };
}

function validateReflectionBackupState(
  state: FullBackupState,
  userId: string,
  requireCompleteIngestLedger: boolean,
): void {
  const turns = indexFullBackupRows(state.turns);
  const candidates = indexFullBackupRows(state.candidates);
  const runs = indexFullBackupRows(state.reflectionRuns);
  const ingestByTurn = new Map<string, FullBackupRow>();
  const ingestSequences = new Set<number>();
  for (const row of state.turnIngestOrder) {
    if (rowText(row, 'user_id') !== userId) {
      throw new Error('完整备份的 ingest ledger 包含其他用户数据');
    }
    const turnId = rowText(row, 'turn_id');
    const turn = turns.get(turnId);
    const sequence = Number(row.ingest_seq);
    const trustedSessionId = turn ? rowText(turn, 'session_id') : '';
    const suppliedSessionId = optionalRowText(row, 'session_id');
    if (
      !turn ||
      rowText(turn, 'user_id') !== userId ||
      rowText(turn, 'namespace') !== rowText(row, 'namespace') ||
      !trustedSessionId ||
      (suppliedSessionId !== null && suppliedSessionId !== trustedSessionId)
    ) {
      throw new Error(
        '完整备份的 ingest ledger 引用了越权或不存在的 turn/session',
      );
    }
    if (
      !Number.isInteger(sequence) ||
      sequence <= 0 ||
      ingestByTurn.has(turnId) ||
      ingestSequences.has(sequence)
    ) {
      throw new Error('完整备份的 ingest ledger 包含重复或无效序号');
    }
    // schema 30 备份没有 session_id；只能从已验证的不可变 turn 绑定补齐。
    row.session_id = trustedSessionId;
    ingestByTurn.set(turnId, row);
    ingestSequences.add(sequence);
  }
  if (
    requireCompleteIngestLedger &&
    ingestByTurn.size !== turns.size
  ) {
    throw new Error('schema 31 完整备份的 ingest ledger 不完整');
  }

  const userScopedReflectionTables: Array<[
    string,
    FullBackupRow[],
  ]> = [
    ['reflectionSettings', state.reflectionSettings],
    ['reflectionCheckpoints', state.reflectionCheckpoints],
    ['reflectionRuns', state.reflectionRuns],
    ['reflectionModelCalls', state.reflectionModelCalls],
    ['reflectionClaims', state.reflectionClaims],
    ['reflectionEvents', state.reflectionEvents],
    ['candidateEvidence', state.candidateEvidence],
  ];
  for (const [label, rows] of userScopedReflectionTables) {
    for (const row of rows) {
      if (rowText(row, 'user_id') !== userId) {
        throw new Error(`完整备份的 ${label} 包含其他用户数据`);
      }
    }
  }

  for (const row of [
    ...state.reflectionCheckpoints,
    ...state.reflectionRuns,
    ...state.reflectionClaims,
  ]) {
    const scope = fullBackupRowScope(row);
    if (
      !FULL_BACKUP_ACCESS_SCOPE_TYPES.has(scope.scopeType) ||
      !scope.scopeKey ||
      (scope.scopeType === 'personal' && scope.scopeKey !== 'self')
    ) {
      throw new Error('完整备份的历史重提炼 scope 无效');
    }
    assertFullBackupScopeHasIdentitySession(
      '完整备份的历史重提炼记录',
      scope,
      state.sessions,
      userId,
      rowText(row, 'namespace'),
    );
  }

  const runTurns = new Map<string, FullBackupRow[]>();
  const runTurnKeys = new Set<string>();
  for (const row of state.reflectionRunTurns) {
    const runId = rowText(row, 'run_id');
    const turnId = rowText(row, 'turn_id');
    const run = runs.get(runId);
    const turn = turns.get(turnId);
    const ingest = ingestByTurn.get(turnId);
    if (!run || !turn || (requireCompleteIngestLedger && !ingest)) {
      throw new Error('完整备份的历史重提炼运行存在孤立 turn');
    }
    if (
      rowText(run, 'user_id') !== rowText(turn, 'user_id') ||
      rowText(run, 'namespace') !== rowText(turn, 'namespace') ||
      (ingest && Number(row.ingest_seq) !== Number(ingest.ingest_seq)) ||
      rowText(row, 'content_hash') !== createHash('sha256')
        .update(rowText(turn, 'content'))
        .digest('hex')
    ) {
      throw new Error('完整备份的历史重提炼运行 turn 归属或哈希不一致');
    }
    const key = `${runId}\u0000${turnId}`;
    if (runTurnKeys.has(key)) {
      throw new Error('完整备份的历史重提炼运行包含重复 turn');
    }
    runTurnKeys.add(key);
    const group = runTurns.get(runId) || [];
    group.push(row);
    runTurns.set(runId, group);
  }
  for (const run of state.reflectionRuns) {
    const runId = rowText(run, 'id');
    const turnsForRun = (runTurns.get(runId) || []).sort(
      (left, right) => Number(left.ordinal) - Number(right.ordinal),
    );
    if (
      Number(run.input_turn_count) !== turnsForRun.length ||
      turnsForRun.some((row, index) => Number(row.ordinal) !== index)
    ) {
      throw new Error('完整备份的历史重提炼运行 turn 清单不完整');
    }
    const expectedHash = createHash('sha256')
      .update(turnsForRun.map((row) => [
        rowText(row, 'turn_id'),
        Number(row.ingest_seq),
        rowText(row, 'content_hash'),
      ].join(':')).join('\n'))
      .digest('hex');
    if (rowText(run, 'turn_set_hash') !== expectedHash) {
      throw new Error('完整备份的历史重提炼运行 turn_set_hash 无效');
    }
    if (turnsForRun.length > 0) {
      const sequences = turnsForRun.map((row) => Number(row.ingest_seq));
      if (
        Number(run.window_start_ingest_seq) !== Math.min(...sequences) ||
        Number(run.window_end_ingest_seq) !== Math.max(...sequences)
      ) {
        throw new Error('完整备份的历史重提炼运行窗口序号不一致');
      }
    }
  }

  for (const checkpoint of state.reflectionCheckpoints) {
    const namespace = rowText(checkpoint, 'namespace');
    const latest = state.turnIngestOrder.reduce(
      (maximum, row) => rowText(row, 'namespace') === namespace
        ? Math.max(maximum, Number(row.ingest_seq))
        : maximum,
      0,
    );
    const checkpointSequence = Number(checkpoint.last_ingest_seq || 0);
    const lastTurnId = optionalRowText(checkpoint, 'last_turn_id');
    const lastTurn = lastTurnId ? turns.get(lastTurnId) : undefined;
    if (
      checkpointSequence < 0 ||
      checkpointSequence > latest ||
      (
        lastTurn &&
        (
          rowText(lastTurn, 'user_id') !== userId ||
          rowText(lastTurn, 'namespace') !== namespace ||
          Number(ingestByTurn.get(lastTurnId!)?.ingest_seq) !==
            checkpointSequence
        )
      )
    ) {
      throw new Error('完整备份的历史重提炼 checkpoint 超前或归属无效');
    }
  }

  for (const call of state.reflectionModelCalls) {
    const run = runs.get(rowText(call, 'run_id'));
    if (
      !run ||
      rowText(call, 'user_id') !== rowText(run, 'user_id') ||
      rowText(call, 'namespace') !== rowText(run, 'namespace')
    ) {
      throw new Error('完整备份的模型调用账本存在孤立或越权运行');
    }
  }

  const claimedCandidates = new Set<string>();
  const claimKeys = new Set<string>();
  for (const claim of state.reflectionClaims) {
    const firstRun = runs.get(rowText(claim, 'first_run_id'));
    const lastRun = runs.get(rowText(claim, 'last_run_id'));
    const claimKey = [
      rowText(claim, 'namespace'),
      rowText(claim, 'scope_type'),
      rowText(claim, 'scope_key'),
      rowText(claim, 'claim_fingerprint'),
    ].join('\u0000');
    if (claimKeys.has(claimKey)) {
      throw new Error('完整备份包含重复 reflection claim');
    }
    claimKeys.add(claimKey);
    if (!firstRun || !lastRun) {
      throw new Error('完整备份的 reflection claim 引用了不存在的运行');
    }
    const scope = fullBackupRowScope(claim);
    for (const run of [firstRun, lastRun]) {
      if (
        rowText(run, 'user_id') !== userId ||
        rowText(run, 'namespace') !== rowText(claim, 'namespace') ||
        !fullBackupScopesEqual(fullBackupRowScope(run), scope)
      ) {
        throw new Error('完整备份的 reflection claim 与运行 scope 不一致');
      }
    }
    const candidateId = optionalRowText(claim, 'candidate_id');
    if (!candidateId) continue;
    const candidate = candidates.get(candidateId);
    if (
      !candidate ||
      claimedCandidates.has(candidateId) ||
      rowText(candidate, 'user_id') !== userId ||
      rowText(candidate, 'namespace') !== rowText(claim, 'namespace') ||
      !fullBackupScopesEqual(fullBackupRowScope(candidate), scope) ||
      optionalRowText(candidate, 'claim_fingerprint') !==
        rowText(claim, 'claim_fingerprint')
    ) {
      throw new Error('完整备份的 reflection claim 候选归属无效或重复');
    }
    claimedCandidates.add(candidateId);
  }

  for (const candidate of state.candidates) {
    const reflectionRunId = optionalRowText(candidate, 'reflection_run_id');
    if (!reflectionRunId) continue;
    const run = runs.get(reflectionRunId);
    if (
      !run ||
      rowText(run, 'user_id') !== rowText(candidate, 'user_id') ||
      rowText(run, 'namespace') !== rowText(candidate, 'namespace') ||
      !fullBackupScopesEqual(
        fullBackupRowScope(run),
        fullBackupRowScope(candidate),
      )
    ) {
      throw new Error('完整备份的候选 reflection run 归属无效');
    }
  }

  const evidenceKeys = new Set<string>();
  for (const evidence of state.candidateEvidence) {
    const candidate = candidates.get(rowText(evidence, 'candidate_id'));
    const turn = turns.get(rowText(evidence, 'turn_id'));
    const key = [
      rowText(evidence, 'candidate_id'),
      rowText(evidence, 'turn_id'),
      rowText(evidence, 'excerpt_hash'),
    ].join('\u0000');
    if (
      !candidate ||
      !turn ||
      evidenceKeys.has(key) ||
      rowText(evidence, 'user_id') !== rowText(candidate, 'user_id') ||
      rowText(evidence, 'namespace') !== rowText(candidate, 'namespace') ||
      rowText(turn, 'user_id') !== rowText(candidate, 'user_id') ||
      rowText(turn, 'namespace') !== rowText(candidate, 'namespace') ||
      !fullBackupScopesEqual(
        fullBackupRowScope(evidence),
        fullBackupRowScope(candidate),
      )
    ) {
      throw new Error('完整备份的候选证据存在孤立、重复或越权引用');
    }
    evidenceKeys.add(key);
    const excerpt = optionalRowText(evidence, 'excerpt');
    if (
      excerpt &&
      createHash('sha256').update(excerpt).digest('hex') !==
        rowText(evidence, 'excerpt_hash')
    ) {
      throw new Error('完整备份的候选证据 excerpt_hash 无效');
    }
  }

  for (const event of state.reflectionEvents) {
    const run = runs.get(rowText(event, 'run_id'));
    if (
      !run ||
      rowText(event, 'user_id') !== rowText(run, 'user_id') ||
      rowText(event, 'namespace') !== rowText(run, 'namespace')
    ) {
      throw new Error('完整备份的 reflection event 存在孤立或越权运行');
    }
    parseFullBackupJsonObject(
      rowText(event, 'detail_json'),
      '完整备份的 reflection event detail',
    );
  }
}

function validateFullBackupState(
  state: FullBackupState,
  userId: string,
  memories: MemoryBackup['memories'],
): void {
  const memoryById = new Map(
    memories.map((memory) => [memory.id, memory]),
  );
  const memoryIds = new Set(memoryById.keys());
  const userScopedTables: Array<
    keyof Pick<
      FullBackupState,
      | 'sessions'
      | 'turns'
      | 'candidates'
      | 'actionRequests'
      | 'items'
      | 'events'
      | 'outbox'
      | 'jobs'
      | 'deadLetters'
      | 'retentionPolicies'
      | 'tombstones'
      | 'consolidations'
      | 'purgeJobs'
      | 'namespaceQualitySnapshots'
      | 'namespaceRolloutState'
      | 'namespaceRecallShadowComparisons'
      | 'episodes'
      | 'patternObservations'
      | 'hierarchicalSummaries'
    >
  > = [
    'sessions',
    'turns',
    'candidates',
    'actionRequests',
    'items',
    'events',
    'outbox',
    'jobs',
    'deadLetters',
    'retentionPolicies',
    'tombstones',
    'consolidations',
    'purgeJobs',
    'namespaceQualitySnapshots',
    'namespaceRolloutState',
    'namespaceRecallShadowComparisons',
    'episodes',
    'patternObservations',
    'hierarchicalSummaries',
  ];
  for (const table of userScopedTables) {
    for (const row of state[table]) {
      const rowUserId = rowText(row, 'user_id');
      if (rowUserId !== userId) {
        throw new Error(`完整备份的 ${table} 包含其他用户数据`);
      }
    }
  }
  for (const session of state.sessions) {
    if (!Object.prototype.hasOwnProperty.call(session, 'project_id')) {
      throw new Error('完整备份的会话缺少 project_id 绑定字段');
    }
    const projectId = session.project_id;
    if (projectId !== null && !isClientIdentityId(projectId)) {
      throw new Error('完整备份的会话包含无效 project_id');
    }
    const identityStatus = rowText(session, 'identity_status') || 'legacy';
    const personaId = optionalRowText(session, 'persona_id');
    if (!['complete', 'degraded', 'legacy'].includes(identityStatus)) {
      throw new Error('完整备份的会话包含无效身份状态');
    }
    if (
      identityStatus === 'complete' &&
      (!personaId || !isClientIdentityId(personaId))
    ) {
      throw new Error('完整备份的完整身份会话缺少有效 persona_id');
    }
    if (
      identityStatus !== 'complete' &&
      (personaId !== null || projectId !== null)
    ) {
      throw new Error('完整备份的非完整身份会话不能携带 persona/project');
    }
  }

  const lookup = createFullBackupLookup(state);
  const sessionIds = new Set(lookup.sessions.keys());
  const turnIds = new Set(lookup.turns.keys());
  const extractionRunIds = new Set(
    state.extractionRuns.map((row) => rowText(row, 'id')),
  );
  const itemIds = new Set(lookup.items.keys());
  const versionIds = new Set(
    state.versions.map((row) => rowText(row, 'id')),
  );
  const eventIds = new Set(lookup.events.keys());
  const candidateIds = new Set(lookup.candidates.keys());
  const consolidationById = indexFullBackupRows(state.consolidations);
  const consolidationIds = new Set(consolidationById.keys());
  const sentenceById = indexFullBackupRows(
    state.consolidationSentences,
  );
  const sentenceIds = new Set(
    sentenceById.keys(),
  );
  const qualitySnapshotIds = new Set(
    state.namespaceQualitySnapshots.map(
      (row) => rowText(row, 'id'),
    ),
  );
  const episodeMemoryCounts = new Map<string, number>();

  for (const episode of state.episodes) {
    const episodeId = rowText(episode, 'id');
    const memoryId = rowText(episode, 'memory_id');
    const session = lookup.sessions.get(rowText(episode, 'session_id'));
    const userTurn = lookup.turns.get(rowText(episode, 'user_turn_id'));
    const assistantTurn = lookup.turns.get(
      rowText(episode, 'assistant_turn_id'),
    );
    const memory = memoryById.get(memoryId);
    if (
      !episodeId || !memory || !session || !userTurn || !assistantTurn ||
      memory.source !== 'conversation_episode' ||
      memory.userId !== userId ||
      memory.namespace !== rowText(episode, 'namespace') ||
      memory.scopeType !== rowText(episode, 'scope_type') ||
      memory.scopeKey !== rowText(episode, 'scope_key') ||
      rowText(session, 'user_id') !== userId ||
      rowText(session, 'namespace') !== rowText(episode, 'namespace') ||
      rowText(userTurn, 'session_id') !== rowText(session, 'id') ||
      rowText(assistantTurn, 'session_id') !== rowText(session, 'id') ||
      rowText(userTurn, 'user_id') !== userId ||
      rowText(assistantTurn, 'user_id') !== userId ||
      rowText(userTurn, 'namespace') !== rowText(episode, 'namespace') ||
      rowText(assistantTurn, 'namespace') !== rowText(episode, 'namespace') ||
      rowText(userTurn, 'role') !== 'user' ||
      rowText(assistantTurn, 'role') !== 'assistant' ||
      rowText(episode, 'content_hash') !== checksum(memory.content) ||
      !fullBackupScopesEqual(
        fullBackupMemoryScope(memory),
        fullBackupRowScope(episode),
      )
    ) {
      throw new Error(
        '完整备份的 episode 存在孤立、越权、哈希或作用域错配',
      );
    }
    episodeMemoryCounts.set(
      memoryId,
      (episodeMemoryCounts.get(memoryId) || 0) + 1,
    );
    assertFullBackupScopeAuthorizedBySession(
      '完整备份的 episode',
      fullBackupRowScope(episode),
      session,
    );
  }
  const episodeTurnKeys = new Set<string>();
  const episodeOrdinals = new Set<string>();
  for (const link of state.episodeTurns) {
    const episode = lookup.episodes.get(rowText(link, 'episode_id'));
    const turn = lookup.turns.get(rowText(link, 'turn_id'));
    const role = rowText(link, 'role');
    const ordinal = Number(link.ordinal);
    const key = [rowText(link, 'episode_id'), rowText(link, 'turn_id')]
      .join('\u0000');
    const ordinalKey = [rowText(link, 'episode_id'), ordinal].join('\u0000');
    if (
      !episode || !turn || episodeTurnKeys.has(key) ||
      episodeOrdinals.has(ordinalKey) ||
      !['user', 'assistant'].includes(role) ||
      ![0, 1].includes(ordinal) ||
      ordinal !== (role === 'user' ? 0 : 1) ||
      role !== rowText(turn, 'role') ||
      rowText(link, 'content_hash') !== createHash('sha256')
        .update(rowText(turn, 'content'))
        .digest('hex') ||
      rowText(turn, 'id') !== (
        role === 'user'
          ? rowText(episode, 'user_turn_id')
          : rowText(episode, 'assistant_turn_id')
      )
    ) {
      throw new Error(
        '完整备份的 episode-turn ordinal、角色或哈希绑定无效或重复',
      );
    }
    episodeTurnKeys.add(key);
    episodeOrdinals.add(ordinalKey);
  }
  for (const episodeId of lookup.episodes.keys()) {
    if (
      !episodeOrdinals.has([episodeId, 0].join('\u0000')) ||
      !episodeOrdinals.has([episodeId, 1].join('\u0000'))
    ) {
      throw new Error('完整备份的 episode 缺少完整 user/assistant turn 绑定');
    }
  }
  for (const memory of memories) {
    if (
      memory.source === 'conversation_episode' &&
      episodeMemoryCounts.get(memory.id) !== 1
    ) {
      throw new Error('完整备份的情景记忆缺少唯一 episode 映射');
    }
  }

  for (const observation of state.patternObservations) {
    const turn = lookup.turns.get(rowText(observation, 'turn_id'));
    const session = lookup.sessions.get(rowText(observation, 'session_id'));
    const excerpt = rowText(observation, 'excerpt');
    const observationScope = fullBackupRowScope(observation);
    const runIds = [
      optionalRowText(observation, 'first_run_id'),
      optionalRowText(observation, 'last_run_id'),
    ].filter((value): value is string => value !== null);
    const observationRuns = runIds.map((runId) =>
      state.reflectionRuns.find((run) => rowText(run, 'id') === runId)
    );
    if (
      !turn || !session || rowText(turn, 'role') !== 'user' ||
      rowText(turn, 'session_id') !== rowText(session, 'id') ||
      rowText(turn, 'user_id') !== userId ||
      rowText(turn, 'namespace') !== rowText(observation, 'namespace') ||
      rowText(session, 'user_id') !== userId ||
      rowText(session, 'namespace') !== rowText(observation, 'namespace') ||
      !excerpt || !rowText(turn, 'content').includes(excerpt) ||
      createHash('sha256').update(excerpt).digest('hex') !==
        rowText(observation, 'excerpt_hash') ||
      observationRuns.some((run) =>
        !run || rowText(run, 'user_id') !== userId ||
        rowText(run, 'namespace') !== rowText(observation, 'namespace') ||
        !fullBackupScopesEqual(fullBackupRowScope(run), observationScope)
      )
    ) {
      throw new Error('完整备份的 pattern observation 存在越权或无效证据');
    }
    assertFullBackupScopeAuthorizedBySession(
      '完整备份的 pattern observation',
      observationScope,
      session,
    );
  }

  const summaryMemoryCounts = new Map<string, number>();
  for (const summary of state.hierarchicalSummaries) {
    const memory = memoryById.get(rowText(summary, 'memory_id'));
    if (
      !memory || memory.source !== 'hierarchical_summary' ||
      memory.userId !== userId ||
      memory.namespace !== rowText(summary, 'namespace') ||
      !fullBackupScopesEqual(
        fullBackupMemoryScope(memory),
        fullBackupRowScope(summary),
      ) ||
      !['session', 'day', 'week'].includes(
        rowText(summary, 'summary_type'),
      )
    ) {
      throw new Error('完整备份的层级摘要存在孤立、越权或作用域错配');
    }
    const memoryId = rowText(summary, 'memory_id');
    summaryMemoryCounts.set(
      memoryId,
      (summaryMemoryCounts.get(memoryId) || 0) + 1,
    );
    assertFullBackupScopeHasIdentitySession(
      '完整备份的层级摘要',
      fullBackupRowScope(summary),
      state.sessions,
      userId,
      rowText(summary, 'namespace'),
    );
  }
  const summarySourceKeys = new Set<string>();
  const summarySourceOrdinals = new Set<string>();
  const summarySourceCounts = new Map<string, number>();
  for (const source of state.hierarchicalSummarySources) {
    const summaryId = rowText(source, 'summary_id');
    const episodeId = rowText(source, 'episode_id');
    const ordinal = Number(source.ordinal);
    const summary = lookup.hierarchicalSummaries.get(summaryId);
    const episode = lookup.episodes.get(episodeId);
    const key = [summaryId, episodeId].join('\u0000');
    const ordinalKey = [summaryId, ordinal].join('\u0000');
    if (
      !summary || !episode || !Number.isInteger(ordinal) || ordinal < 0 ||
      summarySourceKeys.has(key) || summarySourceOrdinals.has(ordinalKey) ||
      rowText(summary, 'user_id') !== rowText(episode, 'user_id') ||
      rowText(summary, 'namespace') !== rowText(episode, 'namespace') ||
      !fullBackupScopesEqual(
        fullBackupRowScope(summary),
        fullBackupRowScope(episode),
      )
    ) {
      throw new Error('完整备份的层级摘要来源存在孤立、重复或越权 episode');
    }
    summarySourceKeys.add(key);
    summarySourceOrdinals.add(ordinalKey);
    summarySourceCounts.set(
      summaryId,
      (summarySourceCounts.get(summaryId) || 0) + 1,
    );
  }
  for (const summary of state.hierarchicalSummaries) {
    if (
      summarySourceCounts.get(rowText(summary, 'id')) !==
      Number(summary.source_count)
    ) {
      throw new Error('完整备份的层级摘要来源数量不完整');
    }
  }
  for (const memory of memories) {
    if (
      memory.source === 'hierarchical_summary' &&
      summaryMemoryCounts.get(memory.id) !== 1
    ) {
      throw new Error('完整备份的派生摘要缺少唯一层级摘要映射');
    }
  }

  if (
    itemIds.size !== memoryIds.size ||
    [...memoryIds].some((id) => !itemIds.has(id))
  ) {
    throw new Error('完整备份的当前投影与规范记忆项不一致');
  }
  for (const item of state.items) {
    const itemId = rowText(item, 'id');
    const memory = memoryById.get(itemId);
    if (!memory) {
      throw new Error('完整备份的当前投影与规范记忆项不一致');
    }
    const projectionChecks: Array<[
      string,
      string,
      string,
    ]> = [
      ['owner', rowText(item, 'user_id'), memory.userId],
      ['namespace', rowText(item, 'namespace'), memory.namespace],
      ['kind', rowText(item, 'kind'), memory.kind],
      ['status', rowText(item, 'status'), memory.status],
    ];
    for (const [field, itemValue, projectionValue] of projectionChecks) {
      if (itemValue !== projectionValue) {
        throw new Error(
          `完整备份的投影与记忆项 ${field} 不一致`,
        );
      }
    }
    const projectionScope = fullBackupMemoryScope(memory);
    const itemScope = fullBackupRowScope(item);
    if (!fullBackupScopesEqual(projectionScope, itemScope)) {
      throw new Error('完整备份的投影与记忆项 scope 不一致');
    }
    assertFullBackupScopeHasIdentitySession(
      '完整备份的投影',
      projectionScope,
      state.sessions,
      memory.userId,
      memory.namespace,
    );

    const currentVersionId = optionalRowText(
      item,
      'current_version_id',
    );
    const currentVersion = currentVersionId
      ? lookup.versions.get(currentVersionId)
      : undefined;
    if (!currentVersion) {
      throw new Error('完整备份的记忆项缺少当前版本');
    }
    if (rowText(currentVersion, 'memory_item_id') !== itemId) {
      throw new Error('完整备份的当前版本不属于对应记忆项');
    }
    if (
      Number(currentVersion.version) !== Number(item.revision)
    ) {
      throw new Error('完整备份的当前版本号与记忆项 revision 不一致');
    }
    if (rowText(currentVersion, 'namespace') !== memory.namespace) {
      throw new Error('完整备份的投影与当前版本 namespace 不一致');
    }
    if (rowText(currentVersion, 'kind') !== memory.kind) {
      throw new Error('完整备份的投影与当前版本 kind 不一致');
    }
    if (
      !fullBackupScopesEqual(
        projectionScope,
        fullBackupRowScope(currentVersion),
      )
    ) {
      throw new Error('完整备份的投影与当前版本 scope 不一致');
    }
    const currentTextChecks: Array<[
      string,
      string | number | null,
      string | number | null,
    ]> = [
      ['title', currentVersion.title, memory.title],
      ['content', currentVersion.content, memory.content],
      ['summary', currentVersion.summary, memory.summary],
      ['tags', currentVersion.tags_json, JSON.stringify(memory.tags)],
      ['importance', currentVersion.importance, memory.importance],
      ['confidence', currentVersion.confidence, memory.confidence],
      ['source', currentVersion.source, memory.source],
      ['source_ref', currentVersion.source_ref, memory.sourceRef],
      ['occurred_at', currentVersion.occurred_at, memory.occurredAt],
      ['valid_from', currentVersion.valid_from, memory.validFrom],
      ['valid_to', currentVersion.valid_to, memory.validTo],
    ];
    for (const [field, versionValue, projectionValue] of currentTextChecks) {
      if (versionValue !== projectionValue) {
        throw new Error(
          `完整备份的投影与当前版本 ${field} 不一致`,
        );
      }
    }
  }
  assertSubset(
    state.turns.map((row) => rowText(row, 'session_id')),
    sessionIds,
    '完整备份的 turn 引用了不存在的会话',
  );
  for (const turn of state.turns) {
    fullBackupTurnSession(lookup, turn, '完整备份的 turn');
  }
  assertSubset(
    state.extractionRuns.map((row) => rowText(row, 'turn_id')),
    turnIds,
    '完整备份的提取运行引用了不存在的 turn',
  );
  assertSubset(
    state.versions.map((row) => rowText(row, 'memory_item_id')),
    itemIds,
    '完整备份的版本引用了不存在的记忆项',
  );
  for (const version of state.versions) {
    const item = lookup.items.get(
      rowText(version, 'memory_item_id'),
    )!;
    const isCurrent =
      optionalRowText(item, 'current_version_id') ===
      rowText(version, 'id');
    const label = isCurrent
      ? '完整备份的当前版本'
      : '完整备份的历史版本';
    const versionNamespace =
      rowText(version, 'namespace') || rowText(item, 'namespace');
    if (!versionNamespace) {
      throw new Error(`${label} 缺少 namespace`);
    }
    assertFullBackupScopeHasIdentitySession(
      label,
      fullBackupRowScope(version),
      state.sessions,
      rowText(item, 'user_id'),
      versionNamespace,
    );
  }
  assertSubset(
    state.items.map((row) =>
      optionalRowText(row, 'current_version_id'),
    ),
    versionIds,
    '完整备份的当前版本指针无效',
  );
  assertSubset(
    state.evidence.map((row) => rowText(row, 'memory_version_id')),
    versionIds,
    '完整备份的证据引用了不存在的版本',
  );
  assertSubset(
    state.evidence.map((row) => optionalRowText(row, 'turn_id')),
    turnIds,
    '完整备份的证据引用了不存在的 turn',
  );
  assertSubset(
    state.candidates.map((row) =>
      optionalRowText(row, 'turn_id'),
    ),
    turnIds,
    '完整备份的候选引用了不存在的 turn',
  );
  assertSubset(
    state.actionRequests.map((row) =>
      optionalRowText(row, 'target_memory_id'),
    ),
    memoryIds,
    '完整备份的自然意图请求引用了不存在的记忆',
  );
  assertSubset(
    state.actionRequests.map((row) =>
      optionalRowText(row, 'candidate_id'),
    ),
    candidateIds,
    '完整备份的自然意图请求引用了不存在的候选',
  );
  assertSubset(
    state.actionRequests.map((row) =>
      optionalRowText(row, 'turn_id'),
    ),
    turnIds,
    '完整备份的自然意图请求引用了不存在的 turn',
  );
  assertSubset(
    state.candidates.map((row) =>
      optionalRowText(row, 'extraction_run_id'),
    ),
    extractionRunIds,
    '完整备份的候选引用了不存在的提取运行',
  );
  assertSubset(
    state.candidates.map((row) =>
      optionalRowText(row, 'resolved_memory_item_id'),
    ),
    itemIds,
    '完整备份的候选引用了不存在的规范记忆',
  );
  assertSubset(
    state.candidateResolutionRuns.map(
      (row) => rowText(row, 'candidate_id'),
    ),
    candidateIds,
    '完整备份的候选解析记录引用了不存在的候选',
  );
  assertSubset(
    state.candidateResolutionRuns.map(
      (row) => optionalRowText(row, 'target_memory_item_id'),
    ),
    itemIds,
    '完整备份的候选解析记录引用了不存在的规范记忆',
  );
  assertSubset(
    state.edges.flatMap((row) => [
      rowText(row, 'from_memory_item_id'),
      rowText(row, 'to_memory_item_id'),
    ]),
    itemIds,
    '完整备份的记忆边引用了不存在的记忆项',
  );
  assertSubset(
    state.events.map((row) =>
      optionalRowText(row, 'memory_item_id'),
    ),
    itemIds,
    '完整备份的事件引用了不存在的记忆项',
  );
  assertSubset(
    state.tombstones.map((row) =>
      optionalRowText(row, 'memory_item_id'),
    ),
    itemIds,
    '完整备份的 tombstone 引用了不存在的记忆项',
  );
  for (const tombstone of state.tombstones) {
    const tombstoneScope = fullBackupRowScope(tombstone);
    const tombstoneUserId = rowText(tombstone, 'user_id');
    const tombstoneNamespace = rowText(tombstone, 'namespace');
    const memoryItemId = optionalRowText(
      tombstone,
      'memory_item_id',
    );
    if (memoryItemId) {
      const item = lookup.items.get(memoryItemId)!;
      if (
        rowText(item, 'user_id') !== tombstoneUserId ||
        rowText(item, 'namespace') !== tombstoneNamespace ||
        !fullBackupScopesEqual(
          fullBackupRowScope(item),
          tombstoneScope,
        )
      ) {
        throw new Error(
          '完整备份的 tombstone 与记忆项 owner/namespace/scope 不一致',
        );
      }
    }
    assertFullBackupScopeHasIdentitySession(
      '完整备份的 tombstone',
      tombstoneScope,
      state.sessions,
      tombstoneUserId,
      tombstoneNamespace,
    );
  }
  assertSubset(
    state.purgeJobs.map((row) => rowText(row, 'memory_id')),
    memoryIds,
    '完整备份的物理清除任务引用了不存在的记忆',
  );
  assertSubset(
    state.consolidations.map((row) =>
      optionalRowText(row, 'memory_id'),
    ),
    memoryIds,
    '完整备份的派生摘要引用了不存在的投影',
  );
  assertSubset(
    state.consolidationSources.map(
      (row) => rowText(row, 'consolidation_id'),
    ),
    consolidationIds,
    '完整备份的派生来源引用了不存在的摘要',
  );
  assertSubset(
    state.consolidationSources.map(
      (row) => rowText(row, 'memory_version_id'),
    ),
    versionIds,
    '完整备份的派生来源引用了不存在的版本',
  );
  assertSubset(
    state.consolidationSentences.map(
      (row) => rowText(row, 'consolidation_id'),
    ),
    consolidationIds,
    '完整备份的摘要句子引用了不存在的摘要',
  );
  assertSubset(
    state.sentenceSources.map(
      (row) => rowText(row, 'sentence_id'),
    ),
    sentenceIds,
    '完整备份的句子来源引用了不存在的句子',
  );
  assertSubset(
    state.sentenceSources.map(
      (row) => rowText(row, 'memory_version_id'),
    ),
    versionIds,
    '完整备份的句子来源引用了不存在的版本',
  );
  const consolidationScopes = new Map<
    string,
    ReturnType<typeof fullBackupConsolidationScopes>
  >();
  for (const consolidation of state.consolidations) {
    const scopes = fullBackupConsolidationScopes(consolidation);
    const consolidationId = rowText(consolidation, 'id');
    const consolidationUserId = rowText(consolidation, 'user_id');
    const consolidationNamespace = rowText(
      consolidation,
      'namespace',
    );
    consolidationScopes.set(consolidationId, scopes);
    assertFullBackupScopeHasIdentitySession(
      '完整备份的派生摘要',
      scopes.accessScope,
      state.sessions,
      consolidationUserId,
      consolidationNamespace,
    );
    if (scopes.groupingSessionScope) {
      assertFullBackupScopeHasIdentitySession(
        '完整备份的派生摘要',
        scopes.groupingSessionScope,
        state.sessions,
        consolidationUserId,
        consolidationNamespace,
      );
    }
    const memoryId = optionalRowText(consolidation, 'memory_id');
    if (memoryId) {
      const projection = memoryById.get(memoryId)!;
      if (
        projection.userId !== consolidationUserId ||
        projection.namespace !== consolidationNamespace ||
        !fullBackupScopesEqual(
          fullBackupMemoryScope(projection),
          scopes.accessScope,
        )
      ) {
        throw new Error(
          '完整备份的派生摘要与输出投影 owner/namespace/scope 不一致',
        );
      }
    }
  }
  const consolidationSourcePairs = new Set(
    state.consolidationSources.map((source) =>
      `${rowText(source, 'consolidation_id')}\u0000${
        rowText(source, 'memory_version_id')
      }`,
    ),
  );
  const assertDerivedSource = (
    label: string,
    consolidationId: string,
    versionId: string,
  ): void => {
    const consolidation = consolidationById.get(consolidationId)!;
    const scopes = consolidationScopes.get(consolidationId)!;
    const version = lookup.versions.get(versionId)!;
    const item = lookup.items.get(
      rowText(version, 'memory_item_id'),
    )!;
    const versionNamespace =
      rowText(version, 'namespace') || rowText(item, 'namespace');
    if (
      rowText(item, 'user_id') !==
        rowText(consolidation, 'user_id') ||
      versionNamespace !== rowText(consolidation, 'namespace') ||
      !fullBackupScopesEqual(
        fullBackupRowScope(version),
        scopes.accessScope,
      )
    ) {
      throw new Error(
        `${label} 与派生摘要 owner/namespace/access scope 不一致`,
      );
    }
  };
  for (const source of state.consolidationSources) {
    assertDerivedSource(
      '完整备份的派生来源',
      rowText(source, 'consolidation_id'),
      rowText(source, 'memory_version_id'),
    );
  }
  for (const source of state.sentenceSources) {
    const sentence = sentenceById.get(rowText(source, 'sentence_id'))!;
    const consolidationId = rowText(sentence, 'consolidation_id');
    const versionId = rowText(source, 'memory_version_id');
    if (
      !consolidationSourcePairs.has(
        `${consolidationId}\u0000${versionId}`,
      )
    ) {
      throw new Error(
        '完整备份的句子来源不属于对应派生摘要来源集',
      );
    }
    assertDerivedSource(
      '完整备份的句子来源',
      consolidationId,
      versionId,
    );
  }
  assertSubset(
    state.namespaceRolloutState.map(
      (row) => optionalRowText(row, 'active_snapshot_id'),
    ),
    qualitySnapshotIds,
    '完整备份的 namespace 灰度状态引用了不存在的质量快照',
  );
  assertSubset(
    state.namespaceRecallShadowComparisons.map(
      (row) => optionalRowText(row, 'snapshot_id'),
    ),
    qualitySnapshotIds,
    '完整备份的召回 shadow 记录引用了不存在的质量快照',
  );

  for (const candidate of state.candidates) {
    const candidateScope = fullBackupRowScope(candidate);
    const turnId = optionalRowText(candidate, 'turn_id');
    const turn = turnId ? lookup.turns.get(turnId) : undefined;
    let session: FullBackupRow | undefined;
    if (turn) {
      session = fullBackupTurnSession(
        lookup,
        turn,
        '完整备份的候选 turn',
      );
      if (
        rowText(candidate, 'user_id') !== rowText(turn, 'user_id') ||
        rowText(candidate, 'namespace') !== rowText(turn, 'namespace')
      ) {
        throw new Error('完整备份的候选与 turn 账户或 namespace 不一致');
      }
      assertFullBackupScopeAuthorizedBySession(
        '完整备份的候选',
        candidateScope,
        session,
      );
    } else if (
      candidateScope.scopeType !== 'personal' ||
      candidateScope.scopeKey !== 'self'
    ) {
      throw new Error('完整备份的作用域候选缺少原始会话绑定');
    }

    const extractionRunId = optionalRowText(
      candidate,
      'extraction_run_id',
    );
    if (extractionRunId) {
      const extractionRun = lookup.extractionRuns.get(extractionRunId);
      if (
        !extractionRun ||
        rowText(extractionRun, 'turn_id') !== turnId
      ) {
        throw new Error('完整备份的候选与提取运行 turn 不一致');
      }
    }

    const resolvedItemId = optionalRowText(
      candidate,
      'resolved_memory_item_id',
    );
    if (resolvedItemId) {
      const resolvedItem = lookup.items.get(resolvedItemId);
      if (
        !resolvedItem ||
        rowText(resolvedItem, 'user_id') !==
          rowText(candidate, 'user_id') ||
        rowText(resolvedItem, 'namespace') !==
          rowText(candidate, 'namespace')
      ) {
        throw new Error('完整备份的候选解析目标超出账户或 namespace');
      }
      if (session) {
        assertFullBackupScopeAuthorizedBySession(
          '完整备份的候选解析目标',
          fullBackupRowScope(resolvedItem),
          session,
        );
      }
    }
  }

  for (const evidence of state.evidence) {
    const turnId = optionalRowText(evidence, 'turn_id');
    if (!turnId) continue;
    const turn = lookup.turns.get(turnId)!;
    const session = fullBackupTurnSession(
      lookup,
      turn,
      '完整备份的证据 turn',
    );
    const version = lookup.versions.get(
      rowText(evidence, 'memory_version_id'),
    )!;
    const item = lookup.items.get(
      rowText(version, 'memory_item_id'),
    )!;
    const versionNamespace =
      rowText(version, 'namespace') || rowText(item, 'namespace');
    if (
      rowText(turn, 'user_id') !== rowText(item, 'user_id') ||
      rowText(turn, 'namespace') !== versionNamespace
    ) {
      throw new Error('完整备份的证据与 turn 账户或 namespace 不一致');
    }
    assertFullBackupScopeAuthorizedBySession(
      '完整备份的证据',
      fullBackupRowScope(version),
      session,
    );
  }

  for (const action of state.actionRequests) {
    const turnId = optionalRowText(action, 'turn_id');
    const turn = turnId ? lookup.turns.get(turnId) : undefined;
    let session: FullBackupRow | undefined;
    if (turn) {
      session = fullBackupTurnSession(
        lookup,
        turn,
        '完整备份的自然意图请求 turn',
      );
      if (
        rowText(action, 'user_id') !== rowText(turn, 'user_id') ||
        rowText(action, 'namespace') !== rowText(turn, 'namespace')
      ) {
        throw new Error(
          '完整备份的自然意图请求与 turn 账户或 namespace 不一致',
        );
      }
    }

    const candidateJsonRaw = optionalRowText(
      action,
      'candidate_json',
    );
    if (candidateJsonRaw) {
      const candidateJson = parseFullBackupJsonObject(
        candidateJsonRaw,
        '完整备份的自然意图请求 candidate JSON',
      );
      if (
        !session &&
        fullBackupJsonScopes(candidateJson).some(
          (scope) =>
            FULL_BACKUP_ACCESS_SCOPE_TYPES.has(scope.scopeType) &&
            scope.scopeType !== 'personal',
        )
      ) {
        throw new Error(
          '完整备份的自然意图请求 candidate JSON 缺少原始会话绑定',
        );
      }
      assertFullBackupJsonScopesAuthorized(
        '完整备份的自然意图请求 candidate JSON',
        candidateJson,
        state.sessions,
        rowText(action, 'user_id'),
        rowText(action, 'namespace'),
        session,
      );
    }

    const candidateId = optionalRowText(action, 'candidate_id');
    if (candidateId) {
      const candidate = lookup.candidates.get(candidateId)!;
      if (
        rowText(candidate, 'user_id') !== rowText(action, 'user_id') ||
        rowText(candidate, 'namespace') !== rowText(action, 'namespace') ||
        (turnId !== null &&
          optionalRowText(candidate, 'turn_id') !== turnId)
      ) {
        throw new Error(
          '完整备份的自然意图请求候选与原始会话不一致',
        );
      }
    }

    const targetMemoryId = optionalRowText(
      action,
      'target_memory_id',
    );
    if (targetMemoryId) {
      const target = memoryById.get(targetMemoryId)!;
      if (
        target.userId !== rowText(action, 'user_id') ||
        target.namespace !== rowText(action, 'namespace')
      ) {
        throw new Error(
          '完整备份的自然意图请求目标超出账户或 namespace',
        );
      }
      if (!session) {
        if (target.scopeType !== 'personal') {
          throw new Error(
            '完整备份的自然意图请求目标缺少原始会话绑定',
          );
        }
      } else {
        try {
          assertFullBackupScopeAuthorizedBySession(
            '完整备份的自然意图请求目标',
            fullBackupMemoryScope(target),
            session,
          );
        } catch {
          throw new Error(
            '完整备份的自然意图请求目标与原始会话不一致',
          );
        }
      }
    }
  }

  for (const resolution of state.candidateResolutionRuns) {
    const candidate = lookup.candidates.get(
      rowText(resolution, 'candidate_id'),
    )!;
    const targetItemId = optionalRowText(
      resolution,
      'target_memory_item_id',
    );
    if (!targetItemId) continue;
    const target = lookup.items.get(targetItemId)!;
    if (
      rowText(candidate, 'user_id') !== rowText(target, 'user_id') ||
      rowText(candidate, 'namespace') !== rowText(target, 'namespace')
    ) {
      throw new Error('完整备份的候选解析记录目标超出账户或 namespace');
    }
    const turnId = optionalRowText(candidate, 'turn_id');
    if (turnId) {
      const session = fullBackupTurnSession(
        lookup,
        lookup.turns.get(turnId)!,
        '完整备份的候选解析记录 turn',
      );
      assertFullBackupScopeAuthorizedBySession(
        '完整备份的候选解析记录目标',
        fullBackupRowScope(target),
        session,
      );
    }
  }

  for (const job of state.jobs) {
    const payload = parseFullBackupJsonObject(
      rowText(job, 'payload_json'),
      '完整备份的任务 payload',
    );
    assertFullBackupJsonScopesAuthorized(
      '完整备份的任务 payload',
      payload,
      state.sessions,
      rowText(job, 'user_id'),
      rowText(job, 'namespace'),
      undefined,
      rowText(job, 'job_type') === 'consolidate_scope',
    );
  }
  for (const deadLetter of state.deadLetters) {
    const payload = parseFullBackupJsonObject(
      rowText(deadLetter, 'payload_json'),
      '完整备份的 dead letter payload',
    );
    assertFullBackupJsonScopesAuthorized(
      '完整备份的 dead letter payload',
      payload,
      state.sessions,
      rowText(deadLetter, 'user_id'),
      rowText(deadLetter, 'namespace'),
      undefined,
      rowText(deadLetter, 'job_type') === 'consolidate_scope',
    );
  }

  for (const row of state.outbox) {
    const aggregateType = rowText(row, 'aggregate_type');
    const aggregateId = rowText(row, 'aggregate_id');
    const scope = fullBackupAggregateScope(
      lookup,
      aggregateType,
      aggregateId,
    );
    if (!scope) {
      throw new Error('完整备份的 outbox 引用了不存在的聚合');
    }
    const outboxUserId = rowText(row, 'user_id');
    const outboxNamespace = rowText(row, 'namespace');
    if (
      !outboxUserId ||
      !outboxNamespace ||
      scope.userId !== outboxUserId ||
      scope.namespace !== outboxNamespace
    ) {
      throw new Error(
        '完整备份的 outbox 聚合与账户或 namespace 作用域不一致',
      );
    }

    const payload = parseFullBackupOutboxPayload(row);
    let aggregateSession: FullBackupRow | undefined;
    if (aggregateType === 'turn') {
      aggregateSession = fullBackupTurnSession(
        lookup,
        scope.row,
        '完整备份的 outbox turn',
      );
    } else if (aggregateType === 'memory_candidate') {
      const candidateTurnId = optionalRowText(scope.row, 'turn_id');
      if (candidateTurnId) {
        aggregateSession = fullBackupTurnSession(
          lookup,
          lookup.turns.get(candidateTurnId)!,
          '完整备份的 candidate outbox turn',
        );
      }
    }
    if (
      aggregateType !== 'memory_event' &&
      !aggregateSession &&
      fullBackupJsonScopes(payload).some(
        (candidateScope) =>
          FULL_BACKUP_ACCESS_SCOPE_TYPES.has(
            candidateScope.scopeType,
          ) && candidateScope.scopeType !== 'personal',
      )
    ) {
      throw new Error('完整备份的 outbox payload 缺少原始会话绑定');
    }
    assertFullBackupJsonScopesAuthorized(
      '完整备份的 outbox payload',
      payload,
      state.sessions,
      outboxUserId,
      outboxNamespace,
      aggregateSession,
    );
    if (aggregateType === 'turn') {
      if (rowText(scope.row, 'role') !== 'user') {
        throw new Error('完整备份的 outbox 聚合不是用户 turn');
      }
      for (const key of ['turnId', 'userTurnId'] as const) {
        const referenced = payload[key];
        if (
          referenced !== undefined &&
          (
            typeof referenced !== 'string' ||
            referenced !== aggregateId
          )
        ) {
          throw new Error(
            '完整备份的 outbox payload turn 与聚合不一致',
          );
        }
      }
      const assistantTurnId = payload.assistantTurnId;
      if (
        assistantTurnId !== undefined &&
        assistantTurnId !== null
      ) {
        if (typeof assistantTurnId !== 'string') {
          throw new Error(
            '完整备份的 outbox assistantTurnId 格式无效',
          );
        }
        const assistant = lookup.turns.get(assistantTurnId);
        if (
          !assistant ||
          rowText(assistant, 'user_id') !== outboxUserId ||
          rowText(assistant, 'namespace') !== outboxNamespace ||
          rowText(assistant, 'role') !== 'assistant' ||
          rowText(assistant, 'session_id') !==
            rowText(scope.row, 'session_id')
        ) {
          throw new Error(
            '完整备份的 outbox assistant turn 超出账户或会话作用域',
          );
        }
      }
      continue;
    }

    if (aggregateType === 'memory_event') {
      const memoryId = payload.memoryId;
      const eventMemoryId = optionalRowText(
        scope.row,
        'memory_item_id',
      );
      if (
        typeof memoryId !== 'string' ||
        memoryId !== eventMemoryId
      ) {
        throw new Error(
          '完整备份的 memory_event outbox payload 与聚合不一致',
        );
      }
      const item = lookup.items.get(memoryId);
      if (
        !item ||
        rowText(item, 'user_id') !== outboxUserId ||
        rowText(item, 'namespace') !== outboxNamespace
      ) {
        throw new Error(
          '完整备份的 memory_event outbox 超出账户作用域',
        );
      }
      continue;
    }

    const candidateId = payload.candidateId;
    if (
      candidateId !== undefined &&
      (
        typeof candidateId !== 'string' ||
        candidateId !== aggregateId
      )
    ) {
      throw new Error(
        '完整备份的 candidate outbox payload 与聚合不一致',
      );
    }
    const resolvedMemoryItemId = payload.resolvedMemoryItemId;
    if (
      resolvedMemoryItemId !== undefined &&
      resolvedMemoryItemId !== null
    ) {
      if (typeof resolvedMemoryItemId !== 'string') {
        throw new Error(
          '完整备份的 candidate outbox 解析目标格式无效',
        );
      }
      const resolved = lookup.items.get(resolvedMemoryItemId);
      if (
        !resolved ||
        rowText(resolved, 'user_id') !== outboxUserId ||
        rowText(resolved, 'namespace') !== outboxNamespace
      ) {
        throw new Error(
          '完整备份的 candidate outbox 解析目标超出账户作用域',
        );
      }
      const resolvedScope = fullBackupRowScope(resolved);
      if (!aggregateSession) {
        if (resolvedScope.scopeType !== 'personal') {
          throw new Error(
            '完整备份的 candidate outbox 解析目标缺少原始会话绑定',
          );
        }
      } else {
        try {
          assertFullBackupScopeAuthorizedBySession(
            '完整备份的 candidate outbox 解析目标',
            resolvedScope,
            aggregateSession,
          );
        } catch {
          throw new Error(
            '完整备份的 candidate outbox 解析目标与原始会话不一致',
          );
        }
      }
    }
  }
}

export class MemoryStore {
  private readonly journal: MemoryJournal;
  private readonly retrievalIndex: HybridRetrievalIndex;
  private readonly retrievalObservability: RetrievalObservability;
  private readonly semanticRanker?: SemanticRanker;
  private readonly semanticRankers: SemanticRanker[];
  private readonly generationRankers = new Map<
    string,
    SemanticRanker
  >();
  private readonly rankerProbes = new Map<
    SemanticRanker,
    { dimensions: number; generationKey: string }
  >();

  constructor(
    private readonly database: DatabaseSync,
    semanticRanker?: SemanticRanker | SemanticRanker[],
  ) {
    this.semanticRankers = Array.isArray(semanticRanker)
      ? [...semanticRanker]
      : semanticRanker
        ? [semanticRanker]
        : [];
    this.semanticRanker = this.semanticRankers[0];
    this.journal = new MemoryJournal(database);
    this.retrievalIndex = new HybridRetrievalIndex(database);
    this.retrievalObservability = new RetrievalObservability(database);
    this.retrievalIndex.ensureIndexed();
  }

  listRetrievalTraces(
    input: Parameters<RetrievalObservability['list']>[1] = {},
    userId = config.defaultUserId,
  ): RetrievalTraceSummary[] {
    return this.retrievalObservability.list(
      cleanUserId(userId),
      input,
    );
  }

  getRetrievalTrace(
    traceId: string,
    userId = config.defaultUserId,
  ): RetrievalTraceDetail | null {
    return this.retrievalObservability.get(
      cleanText(traceId),
      cleanUserId(userId),
    );
  }

  retrievalLogHealth(
    userId = config.defaultUserId,
  ): RetrievalLogHealth {
    return this.retrievalObservability.health(cleanUserId(userId));
  }

  pruneRetrievalTraces(
    before?: string,
    userId = config.defaultUserId,
  ): number {
    return this.retrievalObservability.prune(
      cleanUserId(userId),
      before,
    );
  }

  private createRetrievalTrace(
    input: RecallInput,
    traceContext?: ReliableRecallOptions['traceContext'],
  ): RetrievalTraceSession {
    const ownerId = cleanUserId(input.userId);
    return this.retrievalObservability.createTrace({
      userId: ownerId,
      namespace: cleanText(
        input.namespace,
        config.defaultNamespace,
      ),
      query: cleanText(input.query),
      scopes: normalizeAccessScopes(input),
      request: {
        kinds: input.kinds || [],
        tags: cleanTags(input.tags),
        limit: Math.max(1, Math.min(input.limit || 8, 30)),
        minScore: input.minScore ?? 0.18,
        includeArchived: input.includeArchived === true,
        allowedSensitivities:
          input.allowedSensitivities || ['normal'],
        contextTokenBudget: input.contextTokenBudget || null,
        correlationSource: traceContext?.source || null,
        correlationIdHash: traceContext?.correlationId
          ? retrievalQueryHash(traceContext.correlationId)
          : null,
      },
    });
  }

  canDenseIndex(): boolean {
    return this.semanticRanker !== undefined;
  }

  async prepareDenseIndexScopes(): Promise<void> {
    if (this.semanticRankers.length === 0) return;
    const scopes = this.denseIndexScopes();
    let firstError: unknown;
    for (const ranker of this.semanticRankers) {
      try {
        const probe = await this.probeSemanticRanker(ranker, false);
        for (const scope of scopes) {
          this.registerRankerGeneration(
            ranker,
            probe,
            scope.userId,
            scope.namespace,
          );
        }
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.generationRankers.size === 0 && firstError) {
      throw firstError;
    }
  }

  denseWorkerCapabilities(): {
    modelIds: string[];
    generationIds: string[];
  } {
    const generationIds = [...this.generationRankers.keys()];
    const modelIds = generationIds.flatMap((generationId) => {
      const generation =
        this.retrievalIndex.denseGenerationById(generationId);
      return generation ? [generation.modelId] : [];
    });
    return {
      modelIds: [...new Set(modelIds)],
      generationIds,
    };
  }

  denseIndexAlias(
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
  ): DenseIndexAlias | null {
    return this.retrievalIndex.denseAlias(
      cleanUserId(userId),
      cleanText(namespace, config.defaultNamespace),
    );
  }

  denseIndexGenerations(
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
  ): DenseIndexGeneration[] {
    return this.retrievalIndex.denseGenerationsForScope(
      cleanUserId(userId),
      cleanText(namespace, config.defaultNamespace),
    );
  }

  denseIndexGeneration(
    generationId: string,
  ): DenseIndexGeneration | null {
    return this.retrievalIndex.denseGenerationById(
      cleanText(generationId),
    );
  }

  async denseRankerForGeneration(
    generationId: string,
  ): Promise<SemanticRanker> {
    const generation = this.retrievalIndex.denseGenerationById(
      cleanText(generationId),
    );
    if (!generation) {
      throw new Error('Dense generation 不存在');
    }
    return await this.rankerForGeneration(generation, true);
  }

  async denseEvaluationCandidateIds(input: {
    generationId: string;
    query: string;
    userId?: string;
    namespace?: string;
    limit?: number;
  }): Promise<string[]> {
    const query = cleanText(input.query);
    if (!query) throw new Error('Dense 固定评测查询不能为空');
    const ownerId = cleanUserId(input.userId);
    const namespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    const generation = this.retrievalIndex.denseGenerationById(
      cleanText(input.generationId),
    );
    if (!generation) throw new Error('Dense generation 不存在');
    const ranker = await this.rankerForGeneration(generation, true);
    const vectors = await ranker.embed([
      DENSE_GENERATION_PROBE,
      query,
    ]);
    if (
      vectors.length !== 2 ||
      vectors[0].length !== generation.dimensions ||
      vectors[1].length !== generation.dimensions ||
      denseGenerationKey(vectors[0]) !== generation.generationKey
    ) {
      throw new Error('Dense 固定评测的 embedding generation 不匹配');
    }
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const dense = this.retrievalIndex.searchDenseChannel(
      {
        query,
        userId: ownerId,
        namespace,
        scopes: normalizeAccessScopes({}),
        timestamp: now(),
        denseVector: vectors[1],
        denseModel: generation.embeddingModel,
        denseGenerationKey: generation.generationKey,
        denseGenerationId: generation.generationId,
      },
      limit,
    );
    if (dense.candidates.length === 0) return [];
    const rows = this.database
      .prepare(
        `SELECT memory_id, embedding
         FROM memory_embeddings
         WHERE generation_id = ?
           AND memory_id IN (${dense.candidates.map(() => '?').join(', ')})`,
      )
      .all(
        generation.generationId,
        ...dense.candidates.map((candidate) => candidate.id),
      ) as DatabaseRow[];
    const embeddingById = new Map(
      rows.flatMap((row) =>
        row.embedding instanceof Uint8Array
          ? [[asString(row.memory_id), bufferToVector(row.embedding)] as const]
          : [],
      ),
    );
    return dense.candidates
      .flatMap((candidate) => {
        const vector = embeddingById.get(candidate.id);
        return vector && vector.length === vectors[1].length
          ? [{
              id: candidate.id,
              similarity: cosineSimilarity(vectors[1], vector),
            }]
          : [];
      })
      .sort(
        (left, right) =>
          right.similarity - left.similarity ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((candidate) => candidate.id);
  }

  recordDenseIndexEvaluation(
    report: DenseIndexEvaluationReport,
    userId = config.defaultUserId,
  ): void {
    const ownerId = cleanUserId(userId);
    const generation = this.retrievalIndex.denseGenerationById(
      cleanText(report.generationId),
    );
    const hitsAt20 = report.cases.filter(
      (item) => item.hitAt20,
    ).length;
    const reciprocalRankTotal = report.cases.reduce(
      (total, item) => total + Number(item.reciprocalRank),
      0,
    );
    const computedRecall = report.queryCount > 0
      ? hitsAt20 / report.queryCount
      : 0;
    const computedMrr = report.queryCount > 0
      ? reciprocalRankTotal / report.queryCount
      : 0;
    if (
      !generation ||
      report.generationId !== generation.generationId ||
      report.modelId !== generation.modelId ||
      report.embeddingModel !== generation.embeddingModel ||
      report.generationKey !== generation.generationKey ||
      report.dimensions !== generation.dimensions ||
      report.datasetId !== DENSE_EVALUATION_DATASET_ID ||
      report.evaluatorVersion !== DENSE_EVALUATOR_VERSION ||
      report.datasetSha256 !== DENSE_EVALUATION_DATASET_SHA256 ||
      report.queryCount !== DENSE_EVALUATION_QUERY_COUNT ||
      report.cases.length !== report.queryCount ||
      Math.abs(report.recallAt20 - computedRecall) > 1e-12 ||
      Math.abs(report.mrrAt10 - computedMrr) > 1e-12 ||
      report.passed !== (
        report.recallAt20 >= DENSE_EVALUATION_RECALL_AT_20_MIN &&
        report.mrrAt10 >= DENSE_EVALUATION_MRR_AT_10_MIN
      ) ||
      !cleanText(report.evaluationId)
    ) {
      throw new Error('Dense 固定评测报告不完整或计算不一致');
    }
    const existing = this.denseIndexEvaluation(
      report.evaluationId,
      ownerId,
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(report)) {
        throw new Error('Dense evaluationId 已绑定不同报告');
      }
      return;
    }
    this.audit(
      'dense_index_evaluated',
      null,
      ownerId,
      { ...report },
    );
  }

  denseIndexEvaluation(
    evaluationId: string,
    userId = config.defaultUserId,
  ): DenseIndexEvaluationReport | null {
    const row = this.database
      .prepare(
        `SELECT detail_json
         FROM audit_log
         WHERE user_id = ?
           AND action = 'dense_index_evaluated'
           AND json_extract(detail_json, '$.evaluationId') = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(
        cleanUserId(userId),
        cleanText(evaluationId),
      ) as DatabaseRow | undefined;
    if (!row) return null;
    return parseJson<DenseIndexEvaluationReport | null>(
      row.detail_json,
      null,
    );
  }

  latestDenseIndexEvaluation(
    generationId: string,
    userId = config.defaultUserId,
  ): DenseIndexEvaluationReport | null {
    const ownerId = cleanUserId(userId);
    // The fixed evaluation uses only the synthetic gate dataset and is bound
    // to the immutable generation fingerprint, not to a principal's memories.
    // Prefer that principal's audit row when present, but reuse a report for
    // the same generation so shared model generations do not look degraded.
    const row = this.database
      .prepare(
        `SELECT detail_json
         FROM audit_log
         WHERE action = 'dense_index_evaluated'
           AND json_extract(detail_json, '$.generationId') = ?
         ORDER BY
           CASE WHEN user_id = ? THEN 0 ELSE 1 END,
           created_at DESC,
           id DESC
         LIMIT 1`,
      )
      .get(
        cleanText(generationId),
        ownerId,
      ) as DatabaseRow | undefined;
    if (!row) return null;
    return parseJson<DenseIndexEvaluationReport | null>(
      row.detail_json,
      null,
    );
  }

  failDenseIndexGeneration(
    generationId: string,
    reason: string,
  ): void {
    this.retrievalIndex.failDenseGeneration(
      cleanText(generationId),
      cleanText(reason, 'Dense generation 评测失败'),
      now(),
    );
  }

  denseEmbeddingModels(): string[] {
    return [
      ...new Set(
        this.semanticRankers.map(
          (ranker) => ranker.embeddingModel,
        ),
      ),
    ];
  }

  async activateDenseIndexGeneration(input: {
    generationId: string;
    expectedAliasRevision: number;
    evaluationId: string;
    userId?: string;
    namespace?: string;
  }): Promise<DenseIndexAlias> {
    const ownerId = cleanUserId(input.userId);
    const targetNamespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    const generation =
      this.retrievalIndex.denseGenerationById(
        cleanText(input.generationId),
      );
    if (!generation) {
      throw new Error('待切换的 Dense generation 不存在');
    }
    const evaluation = this.denseIndexEvaluation(
      cleanText(input.evaluationId),
      ownerId,
    );
    if (
      !evaluation ||
      evaluation.generationId !== generation.generationId ||
      evaluation.modelId !== generation.modelId ||
      evaluation.embeddingModel !== generation.embeddingModel ||
      evaluation.generationKey !== generation.generationKey ||
      evaluation.dimensions !== generation.dimensions ||
      evaluation.datasetId !== DENSE_EVALUATION_DATASET_ID ||
      evaluation.evaluatorVersion !== DENSE_EVALUATOR_VERSION ||
      evaluation.datasetSha256 !== DENSE_EVALUATION_DATASET_SHA256 ||
      evaluation.queryCount !== DENSE_EVALUATION_QUERY_COUNT ||
      evaluation.cases.length !== evaluation.queryCount ||
      !evaluation.passed ||
      evaluation.recallAt20 < DENSE_EVALUATION_RECALL_AT_20_MIN ||
      evaluation.mrrAt10 < DENSE_EVALUATION_MRR_AT_10_MIN
    ) {
      throw new Error(
        'Dense generation 缺少可信固定评测或未达到质量门槛',
      );
    }
    await this.rankerForGeneration(generation, true);
    const timestamp = now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const watermark = this.retrievalIndex.denseWatermark({
        userId: ownerId,
        namespace: targetNamespace,
        generationId: generation.generationId,
        embeddingModel: generation.embeddingModel,
        timestamp,
        dimensions: generation.dimensions,
        generationKey: generation.generationKey,
      });
      if (!watermark.complete) {
        throw new Error(
          `Dense generation 回填未完成：${watermark.indexed}/${watermark.eligible}`,
        );
      }
      this.retrievalIndex.markDenseGenerationReady(
        generation.generationId,
        timestamp,
      );
      const alias = this.retrievalIndex.switchDenseAlias({
        userId: ownerId,
        namespace: targetNamespace,
        generationId: generation.generationId,
        expectedRevision: input.expectedAliasRevision,
        timestamp,
      });
      this.audit('dense_index_activated', null, ownerId, {
        namespace: targetNamespace,
        generationId: generation.generationId,
        modelId: generation.modelId,
        evaluationId: evaluation.evaluationId,
        datasetId: evaluation.datasetId,
        datasetSha256: evaluation.datasetSha256,
        evaluatorVersion: evaluation.evaluatorVersion,
        recallAt20: evaluation.recallAt20,
        mrrAt10: evaluation.mrrAt10,
        aliasRevision: alias.revision,
      });
      this.database.exec('COMMIT');
      return alias;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async rollbackDenseIndexGeneration(input: {
    expectedAliasRevision: number;
    reason: string;
    userId?: string;
    namespace?: string;
  }): Promise<DenseIndexAlias> {
    const ownerId = cleanUserId(input.userId);
    const targetNamespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    const alias = this.retrievalIndex.denseAlias(
      ownerId,
      targetNamespace,
    );
    const previous = alias?.previousGenerationId
      ? this.retrievalIndex.denseGenerationById(
          alias.previousGenerationId,
        )
      : null;
    if (!alias || !previous) {
      throw new Error('Dense alias 没有可回滚 previous generation');
    }
    await this.rankerForGeneration(previous, true);
    const timestamp = now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const watermark = this.retrievalIndex.denseWatermark({
        userId: ownerId,
        namespace: targetNamespace,
        generationId: previous.generationId,
        embeddingModel: previous.embeddingModel,
        timestamp,
        dimensions: previous.dimensions,
        generationKey: previous.generationKey,
      });
      if (!watermark.complete) {
        throw new Error(
          `Dense previous generation 不完整：${watermark.indexed}/${watermark.eligible}`,
        );
      }
      const rolledBack = this.retrievalIndex.rollbackDenseAlias({
        userId: ownerId,
        namespace: targetNamespace,
        expectedRevision: input.expectedAliasRevision,
        timestamp,
      });
      this.audit('dense_index_rolled_back', null, ownerId, {
        namespace: targetNamespace,
        generationId: previous.generationId,
        reason: cleanText(input.reason, 'manual rollback'),
        aliasRevision: rolledBack.revision,
      });
      this.database.exec('COMMIT');
      return rolledBack;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  denseIndexScopes(): Array<{
    userId: string;
    namespace: string;
  }> {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT user_id, namespace
         FROM memories
         WHERE status IN ('active', 'archived')
         ORDER BY user_id ASC, namespace ASC`,
      )
      .all() as DatabaseRow[];
    if (rows.length === 0) {
      return [{
        userId: config.defaultUserId,
        namespace: config.defaultNamespace,
      }];
    }
    return rows.map((row) => ({
      userId: asString(row.user_id),
      namespace: asString(row.namespace),
    }));
  }

  denseIndexWatermark(
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
  ): DenseIndexWatermark {
    const ownerId = cleanUserId(userId);
    const targetNamespace = cleanText(
      namespace,
      config.defaultNamespace,
    );
    const alias = this.retrievalIndex.denseAlias(
      ownerId,
      targetNamespace,
    );
    const generation = alias?.activeGenerationId
      ? this.retrievalIndex.denseGenerationById(
          alias.activeGenerationId,
        )
      : null;
    if (!generation) {
      return {
        generationId: null,
        modelId: null,
        model: this.semanticRanker?.embeddingModel ?? null,
        indexVersion: DENSE_LSH_VERSION,
        dimensions: null,
        generationKey: null,
        eligible: 0,
        indexed: 0,
        complete: false,
      };
    }
    const { foreignGenerations: _foreignGenerations, ...coverage } =
      this.retrievalIndex.denseWatermark({
        userId: ownerId,
        namespace: targetNamespace,
        generationId: generation.generationId,
        embeddingModel: generation.embeddingModel,
        timestamp: now(),
        dimensions: generation.dimensions,
        generationKey: generation.generationKey,
      });
    return {
      generationId: generation.generationId,
      modelId: generation.modelId,
      model: generation.embeddingModel,
      indexVersion: generation.indexVersion,
      dimensions: generation.dimensions,
      generationKey: generation.generationKey,
      ...coverage,
    };
  }

  async indexMemoryDense(
    memoryId: string,
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
    beforeCommit?: () => void,
    generationId?: string,
    options?: DenseIncrementalIndexOptions,
  ): Promise<DenseBackfillResult> {
    return await this.backfillDenseIndex(
      1,
      memoryId,
      userId,
      namespace,
      undefined,
      undefined,
      beforeCommit,
      generationId,
      options,
    );
  }

  refreshLocalRetrievalIndex(
    memoryId: string,
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
  ): MemoryRecord {
    const ownerId = cleanUserId(userId);
    const targetNamespace = cleanText(
      namespace,
      config.defaultNamespace,
    );
    const memory = this.get(cleanText(memoryId), true, ownerId);
    if (
      !memory ||
      memory.namespace !== targetNamespace ||
      memory.status !== 'active'
    ) {
      throw new Error('待恢复本地索引的有效记忆不存在或作用域不一致');
    }
    this.indexMemory(memory);
    return memory;
  }

  async indexMemoriesDense(
    memoryIds: string[],
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
    beforeCommit?: () => void,
    generationId?: string,
    options?: DenseIncrementalIndexOptions,
  ): Promise<DenseBackfillResult> {
    const targets = [...new Set(
      memoryIds.map((memoryId) => cleanText(memoryId)).filter(Boolean),
    )];
    if (targets.length === 0) {
      throw new Error('Dense 批量索引至少需要一个 memoryId');
    }
    return await this.backfillDenseIndex(
      config.semanticEmbedBatchSize,
      undefined,
      userId,
      namespace,
      undefined,
      undefined,
      beforeCommit,
      generationId,
      options,
      targets,
    );
  }

  async backfillDenseIndex(
    limit = config.semanticEmbedBatchSize,
    memoryId?: string,
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
    expectedDimensions?: number,
    expectedGenerationKey?: string,
    beforeCommit?: () => void,
    requiredGenerationId?: string,
    incrementalOptions?: DenseIncrementalIndexOptions,
    targetMemoryIds?: string[],
  ): Promise<DenseBackfillResult> {
    if (!this.semanticRanker) {
      return {
        generationId: null,
        modelId: null,
        model: null,
        indexVersion: DENSE_LSH_VERSION,
        dimensions: null,
        generationKey: null,
        eligible: 0,
        indexed: 0,
        complete: false,
        processed: 0,
        available: false,
        telemetry: {
          batchSize: 0,
          batchLeaderJobId: null,
          physicalWorkAttributed: false,
          probeDurationMs: 0,
          embeddingDurationMs: 0,
          databaseWriteDurationMs: 0,
          watermarkDurationMs: 0,
          embeddingBatchCalls: 0,
          watermarkDeferred: false,
        },
      };
    }
    const probeStartedAt = performance.now();
    const timestamp = now();
    const ownerId = cleanUserId(userId);
    const targetNamespace = cleanText(
      namespace,
      config.defaultNamespace,
    );
    let registration: DenseGenerationRegistration;
    let ranker: SemanticRanker;
    if (requiredGenerationId) {
      const generation =
        this.retrievalIndex.denseGenerationById(
          cleanText(requiredGenerationId),
        );
      if (!generation) {
        throw new Error('Dense 任务引用的 generation 不存在');
      }
      ranker = await this.rankerForGeneration(
        generation,
        incrementalOptions?.reusePreparedGenerationProbe !== true,
      );
      const alias = this.retrievalIndex.denseAlias(
        ownerId,
        targetNamespace,
      );
      const role =
        alias?.activeGenerationId === generation.generationId
          ? 'active'
          : alias?.buildingGenerationId === generation.generationId
            ? 'building'
            : alias?.previousGenerationId ===
                generation.generationId
              ? 'previous'
              : null;
      if (!alias || !role) {
        throw new Error('Dense generation 不属于当前 scope alias');
      }
      registration = { generation, alias, role };
    } else {
      const probe = await this.probeSemanticRanker(
        this.semanticRanker,
        true,
      );
      registration = this.registerRankerGeneration(
        this.semanticRanker,
        probe,
        ownerId,
        targetNamespace,
      );
      ranker = this.semanticRanker;
    }
    const generation = registration.generation;
    const probeDurationMs = Number(
      (performance.now() - probeStartedAt).toFixed(3),
    );
    const expectedDimensionValue = Number(expectedDimensions);
    const expectedGenerationValue = cleanText(expectedGenerationKey);
    const dimensions = generation.dimensions;
    const generationKey = generation.generationKey;
    if (
      Number.isInteger(expectedDimensionValue) &&
      expectedDimensionValue > 0 &&
      expectedDimensionValue !== dimensions
    ) {
      throw new Error('dense backfill 的 embedding 维度与任务不一致');
    }
    if (
      expectedGenerationValue &&
      expectedGenerationValue !== generationKey
    ) {
      throw new Error('dense backfill 的 embedding 世代与任务不一致');
    }
    const scopeValues: SQLInputValue[] = [
      ownerId,
      targetNamespace,
      timestamp,
      timestamp,
      timestamp,
    ];
    const scopeFilters = [
      `m.user_id = ?`,
      `m.namespace = ?`,
      `m.status = 'active'`,
      `(m.valid_from IS NULL OR m.valid_from <= ?)`,
      `(m.valid_to IS NULL OR m.valid_to > ?)`,
      `NOT EXISTS (
        SELECT 1
        FROM memory_items scope_item
        WHERE scope_item.id = m.id
          AND scope_item.expires_at IS NOT NULL
          AND scope_item.expires_at <= ?
      )`,
      `NOT EXISTS (
        SELECT 1
        FROM conversation_episode_compactions compacted_episode
        WHERE compacted_episode.memory_id = m.id
      )`,
    ];
    if (memoryId) {
      scopeFilters.push('m.id = ?');
      scopeValues.push(cleanText(memoryId));
    } else if (targetMemoryIds) {
      const targets = [...new Set(
        targetMemoryIds
          .map((targetMemoryId) => cleanText(targetMemoryId))
          .filter(Boolean),
      )].slice(0, 256);
      if (targets.length === 0) {
        scopeFilters.push('1 = 0');
      } else {
        scopeFilters.push(
          `m.id IN (${targets.map(() => '?').join(', ')})`,
        );
        scopeValues.push(...targets);
      }
    }
    const batchLimit = Math.max(
      1,
      Math.min(Math.trunc(limit), 256),
    );
    let rows = this.database
      .prepare(
        `SELECT *
         FROM memories m
         WHERE NOT EXISTS (
           SELECT 1
           FROM memory_embeddings e
           WHERE e.memory_id = m.id
             AND e.generation_id = ?
             AND e.model = ?
             AND e.dimensions = ?
             AND e.generation_key = ?
             AND e.memory_revision = m.semantic_revision
             AND length(e.embedding) = ?
         )
           AND ${scopeFilters.join(' AND ')}
         ORDER BY m.updated_at ASC, m.id ASC
         LIMIT ?`,
      )
      .all(
        generation.generationId,
        generation.embeddingModel,
        dimensions,
        generationKey,
        dimensions * Float32Array.BYTES_PER_ELEMENT,
        ...scopeValues,
        batchLimit,
      ) as DatabaseRow[];
    if (rows.length === 0) {
      rows = this.database
        .prepare(
          `SELECT *
           FROM memories m
           WHERE (
             SELECT COUNT(DISTINCT d.band)
             FROM memory_dense_lsh d
             WHERE d.memory_id = m.id
               AND d.generation_id = ?
               AND d.embedding_model = ?
               AND d.index_version = ?
               AND d.dimensions = ?
               AND d.generation_key = ?
               AND d.memory_revision = m.semantic_revision
           ) != ?
             AND ${scopeFilters.join(' AND ')}
           ORDER BY m.updated_at ASC, m.id ASC
           LIMIT ?`,
        )
        .all(
          generation.generationId,
          generation.embeddingModel,
          DENSE_LSH_VERSION,
          dimensions,
          generationKey,
          DENSE_LSH_BANDS,
          ...scopeValues,
          batchLimit,
        ) as DatabaseRow[];
    }
    const memories = rows.map((row): DenseIndexMemory => ({
      memory: rowToMemory(row),
      semanticRevision: Math.max(
        1,
        Number(row.semantic_revision) || 1,
      ),
    }));
    let processed = 0;
    let embeddingDurationMs = 0;
    let databaseWriteDurationMs = 0;
    let embeddingBatchCalls = 0;
    if (memories.length > 0) {
      const indexed = await this.embedAndIndexMemories(
        memories,
        generation,
        ranker,
        beforeCommit,
      );
      processed = indexed.indexed;
      embeddingDurationMs = indexed.embeddingDurationMs;
      databaseWriteDurationMs = indexed.databaseWriteDurationMs;
      embeddingBatchCalls = indexed.embeddingBatchCalls;
    } else {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        beforeCommit?.();
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
    const generationMetadata = {
      generationId: generation.generationId,
      modelId: generation.modelId,
      model: generation.embeddingModel,
      indexVersion: generation.indexVersion,
      dimensions,
      generationKey,
    };
    const telemetry = {
      batchSize: memories.length,
      batchLeaderJobId:
        cleanText(incrementalOptions?.currentJobId) || null,
      physicalWorkAttributed: true,
      probeDurationMs,
      embeddingDurationMs,
      databaseWriteDurationMs,
      watermarkDurationMs: 0,
      embeddingBatchCalls,
      watermarkDeferred: false,
    };
    if (
      incrementalOptions?.deferScopeWatermarkUntilQueueTail === true &&
      (
        incrementalOptions.deferScopeWatermarkAlways === true ||
        this.hasOtherOpenDenseIndexJob(
          ownerId,
          targetNamespace,
          generation.generationId,
          timestamp,
          incrementalOptions.currentJobIds || (
            incrementalOptions.currentJobId
              ? [incrementalOptions.currentJobId]
              : []
          ),
        )
      )
    ) {
      return {
        ...generationMetadata,
        eligible: processed,
        indexed: processed,
        complete: false,
        processed,
        available: true,
        telemetry: {
          ...telemetry,
          watermarkDeferred: true,
        },
      };
    }
    const watermarkStartedAt = performance.now();
    const watermark = {
      ...generationMetadata,
      ...this.retrievalIndex.denseWatermark({
        userId: ownerId,
        namespace: targetNamespace,
        generationId: generation.generationId,
        embeddingModel: generation.embeddingModel,
        timestamp,
        dimensions,
        generationKey,
      }),
    };
    telemetry.watermarkDurationMs = Number(
      (performance.now() - watermarkStartedAt).toFixed(3),
    );
    if (watermark.complete) {
      this.retrievalIndex.markDenseGenerationReady(
        generation.generationId,
        now(),
      );
    }
    return {
      ...watermark,
      processed,
      available: true,
      telemetry,
    };
  }

  private hasOtherOpenDenseIndexJob(
    userId: string,
    namespace: string,
    generationId: string,
    availableAt: string,
    currentJobIds: string[] = [],
  ): boolean {
    const excludedJobIds = [...new Set(
      currentJobIds.map((jobId) => cleanText(jobId)).filter(Boolean),
    )];
    const row = this.database.prepare(
      `SELECT 1
       FROM memory_jobs
       WHERE job_type = 'index_memory'
         AND user_id = ? AND namespace = ?
         AND required_generation_id = ?
         AND status IN ('pending', 'failed')
         AND available_at <= ?
         ${excludedJobIds.length > 0
           ? `AND id NOT IN (${excludedJobIds.map(() => '?').join(', ')})`
           : ''}
       LIMIT 1`,
    ).get(
      userId,
      namespace,
      generationId,
      availableAt,
      ...excludedJobIds,
    );
    return Boolean(row);
  }

  remember(
    input: RememberInput,
    authorization?: TombstoneWriteAuthorization,
    origin: MemoryOrigin = 'pipeline',
  ): {
    memory: MemoryRecord;
    created: boolean;
    deduplicated: boolean;
  } {
    const content = cleanText(input.content);
    if (!content) throw new Error('记忆内容不能为空');
    if (!isValidKind(input.kind)) throw new Error('无效的记忆类型');

    const userId = cleanUserId(input.userId);
    const namespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    const scopeType = cleanScopeType(input.scopeType);
    const scopeKey = cleanText(input.scopeKey, 'self');
    const sensitivity = cleanSensitivity(input.sensitivity);
    const sourceAuthority = cleanSourceAuthority(
      input.sourceAuthority,
    );
    const negated = input.negated === true;
    if (sensitivity === 'credential') {
      throw new Error('凭据不能保存为长期记忆');
    }
    const contentChecksum = checksum(content);
    const occurredAt = cleanDate(input.occurredAt, 'occurredAt');
    const validFrom = cleanDate(input.validFrom, 'validFrom');
    const validTo = cleanDate(input.validTo, 'validTo');
    validateValidityWindow(validFrom, validTo);
    const tombstoneClaim = {
      userId,
      namespace,
      scopeType,
      scopeKey,
      kind: input.kind,
      content,
      stableKey: input.stableKey,
      normalizedKey: input.predicateKey,
      normalizedValue: input.normalizedValue,
    };
    authorizedTombstoneId(
      this.database,
      tombstoneClaim,
      authorization,
    );

    if (input.idempotencyKey) {
      // v43：幂等键唯一约束含 scope——同一账号跨部门写同名 key 不再
      // 静默去重丢数据，各部门各自独立幂等。
      const existingKey = this.database
        .prepare(
          `SELECT m.*
           FROM idempotency_keys i
           JOIN memories m ON m.id = i.memory_id
           WHERE i.user_id = ? AND i.namespace = ?
             AND i.scope_type = ? AND i.scope_key = ? AND i.key = ?`,
        )
        .get(
          userId,
          namespace,
          scopeType,
          scopeKey,
          input.idempotencyKey,
        ) as DatabaseRow | undefined;
      if (existingKey) {
        return {
          memory: rowToMemory(existingKey),
          created: false,
          deduplicated: true,
        };
      }
    }

    const duplicate = this.database
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ? AND namespace = ? AND checksum = ?
           AND scope_type = ? AND scope_key = ? AND negated = ?
           AND occurred_at IS ? AND valid_from IS ? AND valid_to IS ?
           AND status != 'deleted'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(
        userId,
        namespace,
        contentChecksum,
        scopeType,
        scopeKey,
        negated ? 1 : 0,
        occurredAt,
        validFrom,
        validTo,
      ) as DatabaseRow | undefined;

    if (duplicate) {
      const memory = rowToMemory(duplicate);
      const timestamp = now();
      const importance = Math.max(
        memory.importance,
        clamp(input.importance, memory.importance),
      );
      const confidence = Math.max(
        memory.confidence,
        clamp(input.confidence, memory.confidence),
      );
      const tags = cleanTags([...(memory.tags || []), ...(input.tags || [])]);
      const reinforcedSensitivity =
        sensitivity === 'sensitive' ? 'sensitive' : memory.sensitivity;
      const reinforcedAuthority = strongerSourceAuthority(
        memory.sourceAuthority,
        sourceAuthority,
      );
      const ownsTransaction = !this.database.isTransaction;
      if (ownsTransaction) {
        this.database.exec('BEGIN IMMEDIATE');
      }
      try {
        const tombstoneOverride = authorizedTombstoneId(
          this.database,
          tombstoneClaim,
          authorization,
        );
        this.database
          .prepare(
            `UPDATE memories
             SET last_seen_at = ?, updated_at = ?, importance = ?,
                 confidence = ?, tags_json = ?, sensitivity = ?,
                 source_authority = ?
             WHERE id = ?`,
          )
          .run(
            timestamp,
            timestamp,
            importance,
            confidence,
            JSON.stringify(tags),
            reinforcedSensitivity,
            reinforcedAuthority,
            memory.id,
          );
        const reinforced = this.get(memory.id, true, userId)!;
        const versionId = this.journal.appendVersion(
          reinforced,
          input.createdBy || input.source || 'mcp',
          'reinforced',
          { checksum: contentChecksum },
          {
            canonical: {
              predicateKey: input.predicateKey,
              normalizedValueHash: input.normalizedValueHash,
              normalizedValue: input.normalizedValue,
              predicateCardinality: input.predicateCardinality,
            },
          },
        );
        if (input.evidenceTurnId || input.evidenceExcerpt) {
          this.journal.recordEvidence(versionId, {
            turnId: input.evidenceTurnId,
            evidenceType: 'reinforcement',
            excerpt: input.evidenceExcerpt,
            sourceRef: input.sourceRef,
            sensitivity,
            sourceAuthority,
            createdAt: timestamp,
          });
        }
        this.indexMemory(reinforced);
        this.audit('deduplicate', memory.id, userId, {
          checksum: contentChecksum,
          tombstoneOverride,
        });
        if (ownsTransaction) {
          this.database.exec('COMMIT');
        }
      } catch (error) {
        if (ownsTransaction && this.database.isTransaction) {
          this.database.exec('ROLLBACK');
        }
        throw error;
      }
      return {
        memory: this.get(memory.id, true, userId)!,
        created: false,
        deduplicated: true,
      };
    }

    const id = randomUUID();
    const timestamp = now();
    const title = cleanText(input.title, defaultTitle(content));
    const summary = cleanText(input.summary);
    const tags = cleanTags(input.tags);
    const source = cleanText(input.source, 'mcp');
    const embedding = vectorToBuffer(
      embedText([title, content, summary, tags.join(' ')].join('\n')),
    );

    const insert = this.database.prepare(`
      INSERT INTO memories (
        id, user_id, namespace, scope_type, scope_key, kind,
        title, content, summary,
        tags_json, importance, confidence, status, source, source_ref,
        occurred_at, valid_from, valid_to, created_at, updated_at,
        last_seen_at, access_count, checksum, embedding, sensitivity,
        source_authority, negated, origin, corpus_domain, classification
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?,
        ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) {
      this.database.exec('BEGIN IMMEDIATE');
    }
    try {
      const tombstoneOverride = authorizedTombstoneId(
        this.database,
        tombstoneClaim,
        authorization,
      );
      const stableKey = stableKeyForCreate(this.database, {
        userId,
        namespace,
        kind: input.kind,
        requested: input.stableKey,
        normalizedValue: input.normalizedValue,
        normalizedValueHash: input.normalizedValueHash,
        content,
      });
      insert.run(
        id,
        userId,
        namespace,
        scopeType,
        scopeKey,
        input.kind,
        title,
        content,
        summary,
        JSON.stringify(tags),
        clamp(input.importance, 0.5),
        clamp(input.confidence, 0.8),
        source,
        cleanText(input.sourceRef) || null,
        occurredAt,
        validFrom,
        validTo,
        timestamp,
        timestamp,
        timestamp,
        contentChecksum,
        embedding,
        sensitivity,
        sourceAuthority,
        negated ? 1 : 0,
        origin,
        normalizeCorpusDomain(input.corpusDomain),
        normalizeClassification(input.classification),
      );
      const created = this.get(id, true, userId)!;
      const versionId = this.journal.recordCreate(
        created,
        input.createdBy || source,
        'created',
        stableKey,
        {
          predicateKey: input.predicateKey,
          normalizedValueHash: input.normalizedValueHash,
          normalizedValue: input.normalizedValue,
          predicateCardinality: input.predicateCardinality,
        },
      );
      if (input.evidenceTurnId || input.evidenceExcerpt) {
        this.journal.recordEvidence(versionId, {
          turnId: input.evidenceTurnId,
          evidenceType: 'direct_statement',
          excerpt: input.evidenceExcerpt,
          sourceRef: input.sourceRef,
          sensitivity: created.sensitivity,
          sourceAuthority: created.sourceAuthority,
          createdAt: timestamp,
        });
      }
      this.indexMemory(created);

      if (input.idempotencyKey) {
        this.database
          .prepare(
            `INSERT INTO idempotency_keys (
               user_id, namespace, scope_type, scope_key, key,
               memory_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            namespace,
            scopeType,
            scopeKey,
            input.idempotencyKey,
            id,
            timestamp,
          );
      }

      if (input.supersedesId) {
        const prior = this.get(input.supersedesId, true, userId);
        if (!prior) {
          throw new Error('要替代的记忆不存在或不属于当前用户');
        }
        this.database
          .prepare(
            `UPDATE memories
             SET status = 'superseded', updated_at = ?
             WHERE id = ?`,
          )
          .run(timestamp, input.supersedesId);
        const superseded = this.get(
          input.supersedesId,
          true,
          userId,
        )!;
        this.journal.recordStatus(superseded, 'superseded', {
          supersededBy: id,
        });
        this.addRelation(
          id,
          input.supersedesId,
          'supersedes',
          userId,
        );
      }

      this.audit('remember', id, userId, {
        kind: input.kind,
        namespace,
        source,
        tombstoneOverride,
      });
      if (ownsTransaction) {
        this.database.exec('COMMIT');
      }
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
    return {
      memory: this.get(id, true, userId)!,
      created: true,
      deduplicated: false,
    };
  }

  get(
    id: string,
    includeDeleted = false,
    userId = config.defaultUserId,
    namespace?: string,
  ): MemoryRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM memories
         WHERE id = ? AND user_id = ?
           ${namespace === undefined ? '' : 'AND namespace = ?'}
           ${includeDeleted ? '' : "AND status != 'deleted'"}`,
      )
      .get(
        id,
        cleanUserId(userId),
        ...(namespace === undefined ? [] : [cleanText(namespace)]),
      ) as DatabaseRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  list(input: MemoryListInput = {}): MemoryListResult {
    const where: string[] = ['user_id = ?'];
    const values: SQLInputValue[] = [
      cleanText(input.userId, config.defaultUserId),
    ];

    if (input.query) {
      where.push(
        `(title LIKE ? OR content LIKE ? OR summary LIKE ? OR tags_json LIKE ?)`,
      );
      const query = `%${input.query.trim()}%`;
      values.push(query, query, query, query);
    }
    if (input.namespace) {
      where.push('namespace = ?');
      values.push(input.namespace);
    }
    if (input.scopeKey !== undefined && input.scopeType === undefined) {
      throw new Error('scopeKey 必须与 scopeType 一起使用');
    }
    if (input.scopeType !== undefined) {
      if (
        !['personal', 'project', 'role', 'session', 'public'].includes(
          input.scopeType,
        )
      ) {
        throw new Error('记忆作用域 scopeType 无效');
      }
      where.push('scope_type = ?');
      values.push(input.scopeType);
      if (input.scopeKey !== undefined) {
        const scopeKey = cleanText(input.scopeKey);
        if (!scopeKey) throw new Error('scopeKey 不能为空');
        where.push('scope_key = ?');
        values.push(scopeKey);
      }
    }
    if (input.kind) {
      where.push('kind = ?');
      values.push(input.kind);
    }
    if (input.status) {
      where.push('status = ?');
      values.push(input.status);
    } else {
      where.push("status != 'deleted'");
    }
    if (input.tag) {
      where.push('tags_json LIKE ?');
      values.push(`%${JSON.stringify(input.tag).slice(1, -1)}%`);
    }

    const whereSql = where.join(' AND ');
    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS total FROM memories WHERE ${whereSql}`)
      .get(...values) as DatabaseRow;
    const limit = Math.max(1, Math.min(input.limit || 50, 200));
    const offset = Math.max(0, input.offset || 0);
    const rows = this.database
      .prepare(
        `SELECT * FROM memories
         WHERE ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as DatabaseRow[];

    return {
      items: rows.map(rowToMemory),
      total: Number(totalRow.total),
    };
  }

  update(
    id: string,
    input: UpdateMemoryInput,
    userId = config.defaultUserId,
  ): MemoryRecord {
    const ownerId = cleanUserId(userId);
    const current = this.get(id, true, ownerId);
    if (!current) throw new Error('记忆不存在');
    if (current.status === 'deleted') throw new Error('已删除记忆不能直接编辑');
    if (input.idempotencyKey) {
      const existingKey = this.database
        .prepare(
          `SELECT m.*
           FROM idempotency_keys i
           JOIN memories m ON m.id = i.memory_id
           WHERE i.user_id = ? AND i.namespace = ? AND i.key = ?`,
        )
        .get(
          ownerId,
          current.namespace,
          input.idempotencyKey,
        ) as DatabaseRow | undefined;
      if (existingKey) return rowToMemory(existingKey);
    }

    const nextContent =
      input.content === undefined
        ? current.content
        : cleanText(input.content);
    const currentTitleWasGenerated =
      current.title === defaultTitle(current.content);
    const next = {
      ...current,
      title:
        input.title === undefined
          ? input.content !== undefined && currentTitleWasGenerated
            ? defaultTitle(nextContent)
            : current.title
          : cleanText(input.title, current.title),
      content: nextContent,
      summary:
        input.summary === undefined
          ? current.summary
          : cleanText(input.summary),
      namespace:
        input.namespace === undefined
          ? current.namespace
          : cleanText(input.namespace, current.namespace),
      kind: input.kind || current.kind,
      tags: input.tags === undefined ? current.tags : cleanTags(input.tags),
      importance: clamp(input.importance, current.importance),
      confidence: clamp(input.confidence, current.confidence),
      status: input.status || current.status,
      source:
        input.source === undefined
          ? current.source
          : cleanText(input.source, current.source),
      sourceRef:
        input.sourceRef === undefined
          ? current.sourceRef
          : cleanText(input.sourceRef || '') || null,
      occurredAt:
        input.occurredAt === undefined
          ? current.occurredAt
          : cleanDate(input.occurredAt, 'occurredAt'),
      validFrom:
        input.validFrom === undefined
          ? current.validFrom
          : cleanDate(input.validFrom, 'validFrom'),
      validTo:
        input.validTo === undefined
          ? current.validTo
          : cleanDate(input.validTo, 'validTo'),
      scopeType: cleanScopeType(input.scopeType, current.scopeType),
      scopeKey:
        input.scopeKey === undefined
          ? current.scopeKey
          : cleanText(input.scopeKey, current.scopeKey),
      sensitivity:
        current.sensitivity === 'sensitive'
          ? 'sensitive' as const
          : cleanSensitivity(input.sensitivity, current.sensitivity),
      sourceAuthority: strongerSourceAuthority(
        current.sourceAuthority,
        cleanSourceAuthority(
          input.sourceAuthority,
          current.sourceAuthority,
        ),
      ),
      negated:
        input.negated === undefined ? current.negated : input.negated,
    };

    if (!next.content) throw new Error('记忆内容不能为空');
    if (!isValidKind(next.kind)) throw new Error('无效的记忆类型');
    if (next.sensitivity === 'credential') {
      throw new Error('凭据不能保存为长期记忆');
    }
    validateValidityWindow(next.validFrom, next.validTo);

    const timestamp = now();
    const nextChecksum = checksum(next.content);
    const embedding = vectorToBuffer(embedText(memoryText(next)));
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) {
      this.database.exec('BEGIN IMMEDIATE');
    }
    try {
      this.database
        .prepare(
          `UPDATE memories SET
            namespace = ?, kind = ?, title = ?, content = ?, summary = ?,
            tags_json = ?, importance = ?, confidence = ?, status = ?,
            source = ?, source_ref = ?, occurred_at = ?, valid_from = ?,
            valid_to = ?, updated_at = ?, last_seen_at = ?, checksum = ?,
            embedding = ?, scope_type = ?, scope_key = ?,
            sensitivity = ?, source_authority = ?, negated = ?
           WHERE id = ? AND user_id = ?`,
        )
        .run(
          next.namespace,
          next.kind,
          next.title,
          next.content,
          next.summary,
          JSON.stringify(next.tags),
          next.importance,
          next.confidence,
          next.status,
          next.source,
          next.sourceRef,
          next.occurredAt,
          next.validFrom,
          next.validTo,
          timestamp,
          timestamp,
          nextChecksum,
          embedding,
          next.scopeType,
          next.scopeKey,
          next.sensitivity,
          next.sourceAuthority,
          next.negated ? 1 : 0,
          id,
          ownerId,
        );
      const updated = this.get(id, true, ownerId)!;
      const eventType =
        input.resolutionType === 'reinforcement'
          ? 'reinforced'
          : input.resolutionType === 'correction'
            ? 'corrected'
            : input.resolutionType === 'revert'
              ? 'reverted'
            : 'updated';
      const versionId = this.journal.appendVersion(
        updated,
        input.createdBy || updated.source,
        eventType,
        { fields: Object.keys(input) },
        {
          canonical: {
            predicateKey: input.predicateKey,
            normalizedValueHash: input.normalizedValueHash,
            normalizedValue: input.normalizedValue,
            predicateCardinality: input.predicateCardinality,
          },
          expectedRevision: input.expectedRevision,
          closePreviousVersion: input.closePreviousVersion,
        },
      );
      if (input.evidenceTurnId || input.evidenceExcerpt) {
        this.journal.recordEvidence(versionId, {
          turnId: input.evidenceTurnId,
          evidenceType: input.resolutionType || 'correction',
          excerpt: input.evidenceExcerpt,
          sourceRef: input.sourceRef || undefined,
          sensitivity: updated.sensitivity,
          sourceAuthority: updated.sourceAuthority,
          createdAt: timestamp,
        });
      }
      if (input.idempotencyKey) {
        this.database
          .prepare(
            `INSERT INTO idempotency_keys (
               user_id, namespace, scope_type, scope_key, key,
               memory_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ownerId,
            current.namespace,
            current.scopeType,
            current.scopeKey,
            input.idempotencyKey,
            id,
            timestamp,
          );
      }
      this.indexMemory(updated);
      this.audit('update', id, current.userId, {
        fields: Object.keys(input),
      });
      if (ownsTransaction) {
        this.database.exec('COMMIT');
      }
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
    return this.get(id, true, ownerId)!;
  }

  observe(
    id: string,
    input: ObserveMemoryInput,
    userId = config.defaultUserId,
  ): MemoryRecord {
    const ownerId = cleanUserId(userId);
    const memory = this.get(id, true, ownerId);
    if (!memory || memory.status !== 'active') {
      throw new Error('可观察的当前记忆不存在');
    }
    if (input.sensitivity === 'credential') {
      throw new Error('凭据不能保存为长期记忆');
    }
    if (input.idempotencyKey) {
      const existing = this.database
        .prepare(
          `SELECT memory_id
           FROM idempotency_keys
           WHERE user_id = ? AND namespace = ? AND key = ?`,
        )
        .get(
          ownerId,
          memory.namespace,
          input.idempotencyKey,
        );
      if (existing) return memory;
    }
    const timestamp = now();
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) {
      this.database.exec('BEGIN IMMEDIATE');
    }
    try {
      this.journal.recordObservation(memory, {
        expectedRevision: input.expectedRevision,
        turnId: input.evidenceTurnId,
        excerpt: input.evidenceExcerpt,
        sourceRef: input.sourceRef,
        sensitivity: input.sensitivity,
        sourceAuthority: input.sourceAuthority,
        createdAt: timestamp,
      });
      if (input.idempotencyKey) {
        this.database
          .prepare(
            `INSERT INTO idempotency_keys (
               user_id, namespace, scope_type, scope_key, key,
               memory_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ownerId,
            memory.namespace,
            memory.scopeType,
            memory.scopeKey,
            input.idempotencyKey,
            memory.id,
            timestamp,
          );
      }
      this.audit('observe', memory.id, ownerId, {
        sourceRef: input.sourceRef || null,
      });
      if (ownsTransaction) {
        this.database.exec('COMMIT');
      }
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
    return this.get(memory.id, true, ownerId)!;
  }

  forget(
    id: string,
    reason = '用户请求删除',
    userId = config.defaultUserId,
    authorization?: ForgetTransactionAuthorization,
  ): MemoryRecord {
    const ownerId = cleanUserId(userId);
    const expectedNamespace = authorization
      ? cleanText(authorization.expectedNamespace)
      : null;
    if (authorization && !expectedNamespace) {
      throw new Error('授权遗忘必须指定 namespace');
    }
    const authorizedScopes = new Set<string>();
    for (const scope of authorization?.authorizedScopes || []) {
      if (
        !['personal', 'project', 'role', 'session', 'public'].includes(
          scope.scopeType,
        )
      ) {
        throw new Error('授权遗忘的作用域类型无效');
      }
      const scopeKey = cleanText(scope.scopeKey);
      if (!scopeKey) {
        throw new Error('授权遗忘的作用域 key 不能为空');
      }
      authorizedScopes.add(`${scope.scopeType}\0${scopeKey}`);
    }
    if (authorization && authorizedScopes.size === 0) {
      throw new Error('授权遗忘的可见作用域不能为空');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const memory = this.get(id, true, ownerId);
      if (!memory) throw new Error('记忆不存在');
      if (authorization) {
        if (memory.namespace !== expectedNamespace) {
          throw new Error('所选目标记忆不存在于该请求的命名空间');
        }
        if (
          memory.status !== 'active' &&
          memory.status !== 'archived'
        ) {
          throw new Error('只能忘记当前有效或已归档的目标记忆');
        }
        if (!authorizedScopes.has(
          `${memory.scopeType}\0${memory.scopeKey}`,
        )) {
          throw new Error('遗忘目标对原会话不可见：作用域已变化');
        }
      } else if (memory.status === 'deleted') {
        this.database.exec('COMMIT');
        return memory;
      }
      const timestamp = now();
      const updated = this.database
        .prepare(
          `UPDATE memories
           SET status = 'deleted', deleted_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status != 'deleted'`,
        )
        .run(timestamp, timestamp, id, ownerId);
      if (Number(updated.changes) !== 1) {
        throw new Error('遗忘目标状态已变化');
      }
      const deleted = this.get(id, true, ownerId)!;
      const tombstoneId = this.journal.recordTombstone(deleted, reason);
      this.journal.recordStatus(deleted, 'forgotten', {
        reason,
        tombstoneId,
      });
      this.retrievalIndex.remove(deleted.id);
      this.audit('forget', id, memory.userId, { reason, tombstoneId });
      const callbackResult = authorization?.beforeCommit?.(deleted);
      if (callbackResult !== undefined) {
        throw new Error('遗忘事务 beforeCommit 必须同步执行');
      }
      this.database.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  commitRestore(
    id: string,
    assessment: ClaimRelationAssessment,
    input: RestoreMemoryInput = {},
    userId = config.defaultUserId,
  ): RestoreDecisionResult {
    if (
      input.confirmation !== undefined &&
      input.confirmation !== 'replace'
    ) {
      throw new Error('恢复确认只允许 replace');
    }
    const ownerId = cleanUserId(userId);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const memory = this.get(id, true, ownerId);
      if (!memory) throw new Error('记忆不存在');
      if (memory.sensitivity === 'credential') {
        throw new Error('凭据记忆禁止恢复');
      }
      if (memory.status !== 'deleted') {
        this.database.exec('COMMIT');
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
                  normalized_value, predicate_cardinality, revision,
                  status AS item_status,
                  updated_at AS item_updated_at
           FROM memory_items
           WHERE id = ? AND user_id = ?`,
        )
        .get(id, ownerId) as DatabaseRow | undefined;
      if (!item) throw new Error('记忆真相项不存在');
      const predicateKey = asString(item.predicate_key);
      const cardinality =
        asString(item.predicate_cardinality) || 'single';
      if (assessment.cardinality !== cardinality) {
        throw new Error('恢复评估已过期，请重新检查当前冲突');
      }
      if (asString(item.item_status) !== 'deleted') {
        throw new Error('恢复源真相状态已变化');
      }
      const activeTombstone = this.journal.activeTombstone(
        memory.id,
        ownerId,
      );
      if (!activeTombstone) {
        const priorMerge = this.relations(memory.id).find(
          (relation) => relation.relationType === 'merged_into',
        );
        const merged = priorMerge
          ? this.get(priorMerge.toMemoryId, true, ownerId)
          : null;
        if (merged) {
          this.database.exec('COMMIT');
          return {
            status: 'merged',
            memory: merged,
            conflicts: [],
            tombstonesRestored: 0,
            confirmationToken: null,
            assessment: this.restoreAssessmentSnapshot(
              assessment,
              'merge',
            ),
          };
        }
        throw new Error('当前删除世代不存在，不能恢复');
      }

      const currentTargetRows = this.database
        .prepare(
          `SELECT m.*, i.revision AS canonical_revision,
                  i.status AS canonical_status,
                  i.updated_at AS canonical_updated_at,
                  i.stable_key AS canonical_stable_key,
                  i.predicate_key AS canonical_predicate_key,
                  i.normalized_value_hash
                    AS canonical_normalized_value_hash,
                  i.normalized_value
                    AS canonical_normalized_value,
                  i.observation_count
                    AS canonical_observation_count
           FROM memory_items i
           JOIN memories m ON m.id = i.id
           WHERE i.user_id = ?
             AND i.namespace = ?
             AND i.scope_type = ?
             AND i.scope_key = ?
             AND i.status = 'active'
             AND m.status = 'active'
             AND m.kind = ?
             ${assessment.readSet === 'predicate'
               ? 'AND i.predicate_key = ?'
               : ''}
           ORDER BY i.updated_at DESC, i.id ASC
           LIMIT 128`,
        )
        .all(
          ownerId,
          memory.namespace,
          memory.scopeType,
          memory.scopeKey,
          memory.kind,
          ...(assessment.readSet === 'predicate'
            ? [predicateKey]
            : []),
        ) as DatabaseRow[];
      const currentTargets = currentTargetRows.map((row) => ({
        target: {
          id: asString(row.id),
          revision: Number(row.canonical_revision),
          status: asString(row.canonical_status),
          memoryStatus: asString(row.status),
          itemUpdatedAt: asString(row.canonical_updated_at),
          memoryUpdatedAt: asString(row.updated_at),
          checksum: asString(row.checksum),
          stableKey: asString(row.canonical_stable_key),
          predicateKey: asString(row.canonical_predicate_key),
          normalizedValueHash: asNullableString(
            row.canonical_normalized_value_hash,
          ),
          normalizedValue: asNullableString(
            row.canonical_normalized_value,
          ),
          observationCount: Number(
            row.canonical_observation_count,
          ),
          confidence: Number(row.confidence),
          importance: Number(row.importance),
          content: asString(row.content),
          sensitivity: rowToMemory(row).sensitivity,
          sourceAuthority: rowToMemory(row).sourceAuthority,
          scopeType: rowToMemory(row).scopeType,
          scopeKey: asString(row.scope_key),
          occurredAt: asNullableString(row.occurred_at),
          validFrom: asNullableString(row.valid_from),
          validTo: asNullableString(row.valid_to),
        },
        memory: rowToMemory(row),
        predicateKey: asString(row.canonical_predicate_key),
      }));
      if (
        this.restoreReadSetSignature(
          currentTargets.map(({ target }) => target),
        ) !==
        this.restoreReadSetSignature(assessment.relatedTargets)
      ) {
        throw new Error('恢复评估已过期，请重新检查当前冲突');
      }
      const primaryTarget = assessment.targetMemoryId
        ? currentTargets.find(
            ({ target }) =>
              target.id === assessment.targetMemoryId,
          ) || null
        : null;
      if (assessment.targetMemoryId && !primaryTarget) {
        throw new Error('恢复评估已过期，请重新检查当前冲突');
      }

      const blockingTargets =
        assessment.relation === 'contradicts' ||
        assessment.relation === 'supersedes'
          ? currentTargets.filter(({ target, memory: targetMemory }) =>
              assessment.method === 'rule' &&
              cardinality === 'single' &&
              target.predicateKey === predicateKey
                ? temporalRangesOverlap(memory, targetMemory)
                : target.id === assessment.targetMemoryId,
            )
          : [];
      const blockingConflicts = blockingTargets.map(
        ({ memory: targetMemory }) => targetMemory,
      );
      const timestamp = now();
      if (
        assessment.relation === 'equivalent' ||
        assessment.relation === 'reinforces'
      ) {
        if (!primaryTarget) {
          throw new Error('恢复合并缺少当前目标');
        }
        const tombstonesRestored = this.journal.restoreTombstone(
          activeTombstone,
          timestamp,
        );
        if (tombstonesRestored !== 1) {
          throw new Error('删除世代已变化，请重新执行恢复');
        }
        const mergedMemory =
          assessment.relation === 'reinforces'
            ? this.reinforceRestoreTarget(
                primaryTarget.memory,
                memory,
                primaryTarget.target.revision,
                {
                  predicateKey: primaryTarget.target.predicateKey,
                  normalizedValueHash:
                    primaryTarget.target.normalizedValueHash,
                  normalizedValue:
                    primaryTarget.target.normalizedValue,
                  predicateCardinality: assessment.cardinality,
                },
                timestamp,
              )
            : primaryTarget.memory;
        if (assessment.relation === 'equivalent') {
          this.journal.recordObservation(mergedMemory, {
            expectedRevision: primaryTarget.target.revision,
            sourceRef: `restore:${memory.id}`,
            sensitivity: mergedMemory.sensitivity,
            sourceAuthority: 'user_confirmed',
            createdAt: timestamp,
          });
        }
        this.journal.recordStatus(
          { ...memory, updatedAt: timestamp },
          'restore_merged',
          {
            mergedInto: mergedMemory.id,
            relation: assessment.relation,
            tombstonesRestored,
          },
        );
        this.addRelation(
          memory.id,
          mergedMemory.id,
          'merged_into',
          ownerId,
        );
        this.audit('restore_merge', id, memory.userId, {
          mergedInto: mergedMemory.id,
          relation: assessment.relation,
          method: assessment.method,
          confidence: assessment.confidence,
          rationale: assessment.rationale,
          model: assessment.model,
          promptVersion: assessment.promptVersion,
          tombstonesRestored,
        });
        this.database.exec('COMMIT');
        return {
          status: 'merged',
          memory: this.get(mergedMemory.id, true, ownerId)!,
          conflicts: [],
          tombstonesRestored,
          confirmationToken: null,
          assessment: this.restoreAssessmentSnapshot(
            assessment,
            'merge',
          ),
        };
      }

      const confirmationToken = this.restoreConfirmationToken(
        memory,
        {
          revision: Number(item.revision),
          status: asString(item.item_status),
          updatedAt: asString(item.item_updated_at),
          stableKey: asString(item.stable_key),
          predicateKey,
          cardinality,
          normalizedValueHash: asNullableString(
            item.normalized_value_hash,
          ),
        },
        activeTombstone,
        assessment,
        assessment.relatedTargets,
      );
      if (
        blockingConflicts.length > 0 &&
        !input.confirmation
      ) {
        if (input.confirmationToken) {
          throw new Error('恢复确认动作不能为空');
        }
        const auditDetail = {
          conflictIds: blockingConflicts.map(
            (candidate) => candidate.id,
          ),
          confirmationToken,
          relation: assessment.relation,
          method: assessment.method,
          confidence: assessment.confidence,
          rationale: assessment.rationale,
          model: assessment.model,
          promptVersion: assessment.promptVersion,
          actionPlan: 'replace',
        };
        const duplicatePreview = this.database
          .prepare(
            `SELECT id
             FROM audit_log
             WHERE user_id = ? AND memory_id = ?
               AND action = 'restore_requires_confirmation'
               AND detail_json = ?
             LIMIT 1`,
          )
          .get(
            memory.userId,
            id,
            JSON.stringify(auditDetail),
          );
        if (!duplicatePreview) {
          this.audit(
            'restore_requires_confirmation',
            id,
            memory.userId,
            auditDetail,
          );
        }
        this.database.exec('COMMIT');
        return {
          status: 'requires_confirmation',
          memory,
          conflicts: blockingConflicts,
          tombstonesRestored: 0,
          confirmationToken,
          assessment: this.restoreAssessmentSnapshot(
            assessment,
            'replace',
          ),
        };
      }
      if (
        blockingConflicts.length > 0 &&
        input.confirmation !== 'replace'
      ) {
        throw new Error('冲突恢复必须明确选择 replace');
      }
      if (
        blockingConflicts.length > 0 &&
        input.confirmationToken !== confirmationToken
      ) {
        throw new Error('恢复确认已过期，请重新检查当前冲突');
      }
      if (
        blockingConflicts.length === 0 &&
        (input.confirmation || input.confirmationToken)
      ) {
        throw new Error('当前恢复不需要确认令牌');
      }
      const sourceUpdate = this.database
        .prepare(
          `UPDATE memories
           SET status = 'active', deleted_at = NULL, updated_at = ?,
               source_authority = CASE
                 WHEN source_authority = 'direct_user'
                   THEN 'direct_user'
                 ELSE 'user_confirmed'
               END
           WHERE id = ? AND user_id = ?
             AND status = 'deleted' AND deleted_at IS ?`,
        )
        .run(timestamp, id, ownerId, memory.deletedAt);
      if (Number(sourceUpdate.changes) !== 1) {
        throw new Error('恢复源已变化，请重新执行恢复');
      }
      const restored = this.get(id, true, ownerId)!;
      const restoredTombstoneCount =
        this.journal.restoreTombstone(activeTombstone, timestamp);
      if (restoredTombstoneCount !== 1) {
        throw new Error('删除世代已变化，请重新执行恢复');
      }
      if (blockingConflicts.length > 0) {
        for (const conflict of blockingConflicts) {
          const result = this.database
            .prepare(
              `UPDATE memories
               SET status = 'superseded', updated_at = ?
               WHERE id = ? AND user_id = ? AND status = 'active'`,
            )
            .run(timestamp, conflict.id, ownerId);
          if (Number(result.changes) !== 1) {
            throw new Error('恢复目标已变化，请重新检查当前冲突');
          }
          const superseded = this.get(
            conflict.id,
            true,
            ownerId,
          )!;
          this.journal.recordStatus(superseded, 'superseded', {
            supersededBy: restored.id,
            reason: 'restore_confirmation',
          });
          this.retrievalIndex.remove(superseded.id);
          this.addRelation(
            restored.id,
            superseded.id,
            'supersedes',
            ownerId,
          );
        }
      }
      this.journal.recordStatus(restored, 'restored', {
        tombstonesRestored: restoredTombstoneCount,
        confirmation: input.confirmation || null,
        relation: assessment.relation,
        method: assessment.method,
      });
      this.indexMemory(restored);
      this.audit('restore', id, memory.userId, {
        tombstonesRestored: restoredTombstoneCount,
        confirmation: input.confirmation || null,
        relation: assessment.relation,
        method: assessment.method,
        confidence: assessment.confidence,
        rationale: assessment.rationale,
        model: assessment.model,
        promptVersion: assessment.promptVersion,
        supersededIds: blockingConflicts.map(
          (conflict) => conflict.id,
        ),
      });
      this.database.exec('COMMIT');
      return {
        status: 'restored',
        memory: this.get(id, true, ownerId)!,
        conflicts: blockingConflicts,
        tombstonesRestored: restoredTombstoneCount,
        confirmationToken: null,
        assessment: this.restoreAssessmentSnapshot(
          assessment,
          blockingConflicts.length > 0 ? 'replace' : 'restore',
        ),
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private restoreAssessmentSnapshot(
    assessment: ClaimRelationAssessment,
    actionPlan: RestoreAssessmentSnapshot['actionPlan'],
  ): RestoreAssessmentSnapshot {
    return {
      relation: assessment.relation,
      targetMemoryId: assessment.targetMemoryId,
      method: assessment.method,
      confidence: assessment.confidence,
      rationale: assessment.rationale,
      model: assessment.model,
      promptVersion: assessment.promptVersion,
      actionPlan,
    };
  }

  private restoreConfirmationToken(
    memory: MemoryRecord,
    sourceItem: {
      revision: number;
      status: string;
      updatedAt: string;
      stableKey: string;
      predicateKey: string;
      cardinality: string;
      normalizedValueHash: string | null;
    },
    tombstone: ActiveMemoryTombstone,
    assessment: ClaimRelationAssessment,
    targets: ClaimRelationAssessment['relatedTargets'],
  ): string {
    return checksum(JSON.stringify({
      version: 1,
      purpose: 'memory.restore',
      policyVersion: 'claim-relation-v1',
      allowedActions: ['replace'],
      source: {
        id: memory.id,
        userId: memory.userId,
        namespace: memory.namespace,
        scopeType: memory.scopeType,
        scopeKey: memory.scopeKey,
        kind: memory.kind,
        memoryStatus: memory.status,
        memoryUpdatedAt: memory.updatedAt,
        checksum: memory.checksum,
        deletedAt: memory.deletedAt,
        itemRevision: sourceItem.revision,
        itemStatus: sourceItem.status,
        itemUpdatedAt: sourceItem.updatedAt,
        stableKey: sourceItem.stableKey,
        predicateKey: sourceItem.predicateKey,
        cardinality: sourceItem.cardinality,
        normalizedValueHash: sourceItem.normalizedValueHash,
      },
      tombstone: {
        id: tombstone.id,
        generation: tombstone.deletionGeneration,
        createdAt: tombstone.createdAt,
      },
      relation: assessment.relation,
      method: assessment.method,
      readSet: assessment.readSet,
      targetMemoryId: assessment.targetMemoryId,
      model: assessment.model,
      promptVersion: assessment.promptVersion,
      rationaleHash: checksum(assessment.rationale),
      targets: targets
        .map((target) => ({
          id: target.id,
          itemRevision: target.revision,
          itemStatus: target.status,
          itemUpdatedAt: target.itemUpdatedAt,
          memoryStatus: target.memoryStatus,
          memoryUpdatedAt: target.memoryUpdatedAt,
          checksum: target.checksum,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }));
  }

  private restoreReadSetSignature(
    targets: ReadonlyArray<{
      id: string;
      revision: number;
      status: string;
      memoryStatus: string;
      itemUpdatedAt: string;
      memoryUpdatedAt: string;
      checksum: string;
    }>,
  ): string {
    return checksum(JSON.stringify(
      targets
        .map((target) => ({
          id: target.id,
          itemRevision: target.revision,
          itemStatus: target.status,
          memoryStatus: target.memoryStatus,
          itemUpdatedAt: target.itemUpdatedAt,
          memoryUpdatedAt: target.memoryUpdatedAt,
          checksum: target.checksum,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ));
  }

  private reinforceRestoreTarget(
    current: MemoryRecord,
    restoredSource: MemoryRecord,
    expectedRevision: number,
    canonical: {
      predicateKey: string;
      normalizedValueHash: string | null;
      normalizedValue: string | null;
      predicateCardinality: PredicateCardinality;
    },
    timestamp: string,
  ): MemoryRecord {
    const observationCount = Math.max(
      1,
      Number(
        this.database
          .prepare(
            `SELECT observation_count
             FROM memory_items
             WHERE id = ? AND user_id = ? AND revision = ?`,
          )
          .get(
            current.id,
            current.userId,
            expectedRevision,
          )?.observation_count || 1,
      ),
    );
    const confidence = Number(
      (
        (
          current.confidence * observationCount +
          restoredSource.confidence
        ) /
        (observationCount + 1)
      ).toFixed(4),
    );
    const sourceAuthority = strongerSourceAuthority(
      current.sourceAuthority,
      'user_confirmed',
    );
    const result = this.database
      .prepare(
        `UPDATE memories
         SET confidence = ?, importance = ?, last_seen_at = ?,
             updated_at = ?, source_authority = ?
         WHERE id = ? AND user_id = ? AND status = 'active'`,
      )
      .run(
        confidence,
        Math.max(current.importance, restoredSource.importance),
        timestamp,
        timestamp,
        sourceAuthority,
        current.id,
        current.userId,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('恢复强化目标已变化');
    }
    const reinforced = this.get(
      current.id,
      true,
      current.userId,
    )!;
    const versionId = this.journal.appendVersion(
      reinforced,
      'memory-admin',
      'reinforced',
      {
        restoredSourceId: restoredSource.id,
        resolutionType: 'restore_reinforcement',
      },
      {
        expectedRevision,
        canonical: {
          predicateKey: canonical.predicateKey,
          normalizedValueHash:
            canonical.normalizedValueHash || undefined,
          normalizedValue: canonical.normalizedValue || undefined,
          predicateCardinality: canonical.predicateCardinality,
        },
      },
    );
    this.journal.recordEvidence(versionId, {
      evidenceType: 'restore_reinforcement',
      excerpt: restoredSource.content,
      sourceRef: `restore:${restoredSource.id}`,
      sensitivity: restoredSource.sensitivity,
      sourceAuthority: 'user_confirmed',
      createdAt: timestamp,
    });
    return reinforced;
  }

  revertToVersion(
    id: string,
    targetVersionId: string,
    userId = config.defaultUserId,
  ): MemoryRecord {
    const ownerId = cleanUserId(userId);
    const current = this.get(id, true, ownerId);
    if (!current) throw new Error('记忆不存在');
    if (current.status === 'deleted') {
      throw new Error('已删除记忆不能直接撤销版本');
    }
    const target = this.database
      .prepare(
        `SELECT
           v.*,
           i.revision AS item_revision,
           i.current_version_id
         FROM memory_versions v
         JOIN memory_items i ON i.id = v.memory_item_id
         WHERE v.id = ?
           AND v.memory_item_id = ?
           AND i.user_id = ?`,
      )
      .get(
        cleanText(targetVersionId),
        id,
        ownerId,
      ) as DatabaseRow | undefined;
    if (!target) throw new Error('目标历史版本不存在');
    if (asString(target.current_version_id) === targetVersionId) {
      return current;
    }

    return this.update(
      id,
      {
        title: asString(target.title),
        content: asString(target.content),
        summary: asString(target.summary),
        namespace: asString(target.namespace) || current.namespace,
        kind:
          (asString(target.kind) as MemoryRecord['kind']) ||
          current.kind,
        tags: parseJson<string[]>(target.tags_json, []),
        importance: Number(target.importance),
        confidence: Number(target.confidence),
        source: 'user-revert',
        sourceRef: `version:${targetVersionId}`,
        occurredAt: asNullableString(target.occurred_at),
        validFrom: asNullableString(target.valid_from),
        validTo: asNullableString(target.valid_to),
        scopeType:
          (asString(target.scope_type) as MemoryRecord['scopeType']) ||
          current.scopeType,
        scopeKey: asString(target.scope_key) || current.scopeKey,
        sensitivity:
          (asString(
            target.sensitivity,
          ) as MemoryRecord['sensitivity']) || current.sensitivity,
        sourceAuthority:
          (asString(
            target.source_authority,
          ) as MemoryRecord['sourceAuthority']) ||
          current.sourceAuthority,
        negated: Number(target.negated) === 1,
        createdBy: 'user-revert',
        idempotencyKey: [
          'revert',
          id,
          targetVersionId,
          Number(target.item_revision),
        ].join(':'),
        expectedRevision: Number(target.item_revision),
        closePreviousVersion: true,
        resolutionType: 'revert',
        predicateKey: asString(target.predicate_key) || undefined,
        normalizedValueHash:
          asString(target.normalized_value_hash) || undefined,
        normalizedValue:
          asString(target.normalized_value) || undefined,
        predicateCardinality:
          asString(target.predicate_cardinality) as
            | 'single'
            | 'set'
            | 'event'
            | undefined,
      },
      ownerId,
    );
  }

  recall(input: RecallInput): RecallResult[] {
    const trace = this.createRetrievalTrace(input);
    try {
      const results = this.recallLocalInternal(input, trace);
      trace.event('context', {
        skipped: true,
        reason: 'recall_only',
        injectedMemoryIds: [],
        actualTokens: 0,
      });
      trace.finish({
        qualityState: 'degraded',
        resultCount: results.length,
        detail: { resultIds: results.map((result) => result.memory.id) },
      });
      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace.completeFailedStages('local_recall_failed', message);
      trace.finish({
        qualityState: 'unavailable',
        resultCount: 0,
        errorCode: 'local_recall_failed',
        detail: { error: message },
      });
      throw error;
    }
  }

  private recallLocalInternal(
    input: RecallInput,
    trace: RetrievalTraceSession,
  ): RecallResult[] {
    const query = cleanText(input.query);
    if (!query) throw new Error('召回查询不能为空');
    const ownerId = cleanUserId(input.userId);
    // bi-temporal as-of：与 recallReliableInternal 同一约定（该函数所有
    // timestamp 消费点均为只读查询）。
    const timestamp = input.timestamp
      ? cleanDate(input.timestamp, 'timestamp') || now()
      : now();
    const scopes = normalizeAccessScopes(input);

    const candidateSearch = this.indexedRecallCandidates(
      {
        ...input,
        query,
        scopes,
        scopeType: undefined,
        scopeKey: undefined,
      },
      ownerId,
      timestamp,
    );
    const candidates = candidateSearch.candidates;
    const searchDiagnostics = candidateSearch.diagnostics;
    const temporalPlan = temporalRetrievalPlan(
      query,
      undefined,
      timestamp,
    );
    const temporalEvidenceDigests = temporalPlan
      ? this.memoryEvidenceDigests(
          candidates.map((candidate) => candidate.memory.id),
          ownerId,
        )
      : null;
    const queryVector = embedText(query);
    const minRelevance = Math.max(
      0.12,
      Math.min(1, input.minScore ?? 0.18),
    );
    let topicFilteredCount = 0;
    let relevanceFilteredCount = 0;
    const candidateDecisions: RetrievalCandidateDecision[] = [];
    const rankedResults = candidates
      .map((candidate): RecallResult | null => {
        const { memory, retrieval, rawEmbedding } = candidate;
        const vector =
          rawEmbedding instanceof Uint8Array
            ? bufferToVector(rawEmbedding)
            : embedText(memoryText(memory));
        const memoryContent = memoryText(memory);
        const vectorScore = cosineSimilarity(queryVector, vector);
        const overlap = tokenOverlap(query, memoryContent);
        const topicOverlap = topicTokenOverlap(query, memoryContent);
        if (topicOverlap < 0.3) {
          topicFilteredCount += 1;
          candidateDecisions.push({
            memoryId: memory.id,
            stage: 'semantic',
            decision: 'rejected',
            evaluated: true,
            reasonCode: 'topic_overlap_below_threshold',
            score: Number(topicOverlap.toFixed(6)),
            threshold: 0.3,
          });
          return null;
        }
        const relevance = vectorScore * 0.45 + topicOverlap * 0.55;
        if (relevance < minRelevance) {
          relevanceFilteredCount += 1;
          candidateDecisions.push({
            memoryId: memory.id,
            stage: 'semantic',
            decision: 'rejected',
            evaluated: true,
            reasonCode: 'local_relevance_below_threshold',
            score: Number(relevance.toFixed(6)),
            threshold: minRelevance,
          });
          return null;
        }
        const recency = recencyScore(memory.updatedAt);
        const temporalSignal = temporalCandidateSignal(
          temporalPlan,
          memory,
          temporalEvidenceDigests?.get(memory.id),
        );
        const channelScore = Math.min(
          1,
          retrieval.fusedScore * 30,
        );
        const baseScore =
          relevance * 0.7 +
          channelScore * 0.08 +
          memory.importance * 0.1 +
          memory.confidence * 0.07 +
          recency * 0.05;
        const score = temporalPlan
          ? baseScore * 0.85 + (temporalSignal?.score || 0) * 0.15
          : baseScore;
        const reasons: string[] = [];
        if (retrieval.lexicalRank) {
          reasons.push(`FTS5/BM25 第 ${retrieval.lexicalRank} 名`);
        }
        if (retrieval.annRank) {
          reasons.push(
            `MinHash-LSH 近邻第 ${retrieval.annRank} 名`,
          );
        }
        if (retrieval.termRank) {
          reasons.push(
            `实体/概念倒排第 ${retrieval.termRank} 名`,
          );
        }
        if (topicOverlap >= 0.3) reasons.push('主题词高度相关');
        else reasons.push('包含相同主题词');
        if (overlap >= 0.3) reasons.push('内容关键词高度相关');
        if (vectorScore >= 0.25) reasons.push('本地向量相似');
        if (memory.importance >= 0.8) reasons.push('高重要度记忆');
        if (recency >= 0.8) reasons.push('近期更新');
        if (temporalPlan && temporalSignal) {
          reasons.push(temporalReason(temporalPlan, temporalSignal));
        }

        return {
          memory,
          score: Number(score.toFixed(4)),
          reasons: reasons.length ? reasons : ['综合排序命中'],
          explanation: {
            lexicalRank: retrieval.lexicalRank,
            annRank: retrieval.annRank,
            termRank: retrieval.termRank,
            graphRank: retrieval.graphRank,
            semanticSimilarity: Number(vectorScore.toFixed(4)),
            rerankConfidence: null,
            feedbackPrior: 0,
            importance: Number(memory.importance.toFixed(4)),
            memoryConfidence: Number(memory.confidence.toFixed(4)),
            recency: Number(recency.toFixed(4)),
            status: memory.status,
            conflictState: conflictState(memory.status),
            diversityPenalty: 0,
          },
        };
      })
      .filter((result): result is RecallResult => result !== null)
      .sort((left, right) => right.score - left.score);
    const resultLimit = Math.max(
      1,
      Math.min(input.limit || 8, 30),
    );
    const consolidated = this.collapseCoveredAtomicResults(
      rankedResults,
    );
    const consolidatedIds = new Set(
      consolidated.results.map((result) => result.memory.id),
    );
    candidateDecisions.push(
      ...rankedResults
        .filter((result) => !consolidatedIds.has(result.memory.id))
        .map((result): RetrievalCandidateDecision => ({
          memoryId: result.memory.id,
          stage: 'selection',
          decision: 'rejected',
          evaluated: true,
          reasonCode: 'derived_summary_coverage',
        })),
    );
    const scopeFiltered = this.applyScopePrecedence(
      consolidated.results,
    );
    const scopeFilteredIds = new Set(
      scopeFiltered.results.map((result) => result.memory.id),
    );
    candidateDecisions.push(
      ...consolidated.results
        .filter((result) => !scopeFilteredIds.has(result.memory.id))
        .map((result): RetrievalCandidateDecision => ({
          memoryId: result.memory.id,
          stage: 'selection',
          decision: 'rejected',
          evaluated: true,
          reasonCode: 'scope_precedence',
        })),
    );
    const results = orderTemporalResults(
      temporalPlan,
      selectLayeredRecallResults(
        selectDiverseResults(
          scopeFiltered.results,
          scopeFiltered.results.length,
        ),
        resultLimit,
      ),
    );
    const selectedIds = new Set(
      results.map((result) => result.memory.id),
    );
    candidateDecisions.push(
      ...scopeFiltered.results
        .filter((result) => !selectedIds.has(result.memory.id))
        .map((result): RetrievalCandidateDecision => ({
          memoryId: result.memory.id,
          stage: 'selection',
          decision: 'rejected',
          evaluated: true,
          reasonCode: 'result_limit_or_diversity',
        })),
    );
    const filterSummary = [
      {
        reasonCode: 'topic_overlap_below_threshold',
        reason: '主题不匹配',
        count: topicFilteredCount,
      },
      {
        reasonCode: 'local_relevance_below_threshold',
        reason: '相关性低于门槛',
        count: relevanceFilteredCount,
      },
      {
        reasonCode: 'derived_summary_coverage',
        reason: '被有效派生摘要覆盖',
        count: consolidated.suppressedCount,
      },
      {
        reasonCode: 'scope_precedence',
        reason: '被更高优先级作用域遮蔽',
        count: scopeFiltered.suppressedCount,
      },
      {
        reasonCode: 'result_limit_or_diversity',
        reason: '超过结果数量上限',
        count: Math.max(
          scopeFiltered.results.length - results.length,
          0,
        ),
      },
    ].filter((item) => item.count > 0);

    const updateAccess = this.database.prepare(
      `UPDATE memories
       SET access_count = access_count + 1, last_accessed_at = ?
       WHERE id = ? AND user_id = ?`,
    );
    const updateRetrieved = this.database.prepare(
      `UPDATE memory_items
       SET retrieved_count = retrieved_count + 1
       WHERE id = ? AND user_id = ?`,
    );
    this.database.exec('BEGIN');
    try {
      if (results.length) {
        for (const result of results) {
          updateAccess.run(timestamp, result.memory.id, ownerId);
          updateRetrieved.run(result.memory.id, ownerId);
        }
      }
      this.audit('recall', null, ownerId, {
        traceId: trace.traceId,
        queryHash: retrievalQueryHash(query),
        query: config.retrievalLogMode === 'diagnostic'
          ? query
          : undefined,
        mode: 'hybrid-local',
        qualityState: 'degraded',
        temporalIntent: temporalPlan
          ? {
              kind: temporalPlan.kind,
              label: temporalPlan.label,
              rangeStartAt: temporalPlan.rangeStartMs === null
                ? null
                : new Date(temporalPlan.rangeStartMs).toISOString(),
              rangeEndAt: temporalPlan.rangeEndMs === null
                ? null
                : new Date(temporalPlan.rangeEndMs).toISOString(),
            }
          : null,
        minRelevance,
        candidateCount: candidates.length,
        lexicalCandidateCount: candidates.filter(
          ({ retrieval }) => retrieval.lexicalRank !== null,
        ).length,
        annCandidateCount: candidates.filter(
          ({ retrieval }) => retrieval.annRank !== null,
        ).length,
        termCandidateCount: candidates.filter(
          ({ retrieval }) => retrieval.termRank !== null,
        ).length,
        filterSummary,
        candidateDecisions,
        resultIds: results.map((result) => result.memory.id),
        resultDetails: this.recallResultDetails(results, ownerId),
      });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    trace.event('rewrite', {
      mode: 'local',
      triggered: false,
      variants: [{ query, type: 'original' }],
    });
    trace.event('channels', {
      diagnosticsByVariant: [{
        variantType: 'original',
        annMode: searchDiagnostics.annMode,
        perChannelLimit: searchDiagnostics.perChannelLimit,
        channels: searchDiagnostics.channels,
      }],
      truncationSummary: [
        {
          reasonCode: 'lexical_channel_cap',
          count: searchDiagnostics.channels.lexical.cappedCount,
        },
        {
          reasonCode: 'ann_channel_cap',
          count: searchDiagnostics.channels.ann.cappedCount,
        },
        {
          reasonCode: 'term_channel_cap',
          count: searchDiagnostics.channels.term.cappedCount,
        },
      ].filter((item) => item.count > 0),
      lexicalCandidateCount: candidates.filter(
        ({ retrieval }) => retrieval.lexicalRank !== null,
      ).length,
      annCandidateCount: candidates.filter(
        ({ retrieval }) => retrieval.annRank !== null,
      ).length,
      termCandidateCount: candidates.filter(
        ({ retrieval }) => retrieval.termRank !== null,
      ).length,
      graphCandidateCount: 0,
    });
    trace.event('fusion', {
      strategy: 'local-hybrid-score',
      candidateCount: candidates.length,
      diagnosticsByVariant: [{
        variantType: 'original',
        limit: searchDiagnostics.limit,
        fusion: searchDiagnostics.fusion,
      }],
      truncationSummary: [{
        reasonCode: 'fusion_candidate_cap',
        count: searchDiagnostics.fusion.cappedCount,
      }, {
        reasonCode: 'invalid_derived_source',
        count: searchDiagnostics.fusion.invalidDerivedSourceCount,
      }].filter((item) => item.count > 0),
      candidates: candidates.map((candidate) => ({
        memoryId: candidate.memory.id,
        fusedScore: Number(candidate.retrieval.fusedScore.toFixed(6)),
      })),
    });
    trace.event('semantic', {
      mode: 'local-fallback',
      minRelevance,
      topicFilteredCount,
      relevanceFilteredCount,
      temporalIntent: temporalPlan
        ? {
            kind: temporalPlan.kind,
            label: temporalPlan.label,
            rangeStartAt: temporalPlan.rangeStartMs === null
              ? null
              : new Date(temporalPlan.rangeStartMs).toISOString(),
            rangeEndAt: temporalPlan.rangeEndMs === null
              ? null
              : new Date(temporalPlan.rangeEndMs).toISOString(),
          }
        : null,
      temporalScoredCandidateCount: temporalPlan
        ? candidates.filter((candidate) => temporalCandidateSignal(
            temporalPlan,
            candidate.memory,
            temporalEvidenceDigests?.get(candidate.memory.id),
          ) !== null).length
        : 0,
    });
    trace.event('rerank', {
      model: null,
      stages: [],
      attemptedCandidates: 0,
      decisions: [],
      skipped: true,
      reason: 'local_fallback_without_reranker',
    });
    trace.event('selection', {
      filterSummary,
      candidateDecisions,
      resultIds: results.map((result) => result.memory.id),
    });
    return results.map((result) => ({
      ...result,
      traceId: trace.traceId,
    }));
  }

  async recallReliable(
    input: RecallInput,
    options: ReliableRecallOptions = {},
  ): Promise<RecallResult[]> {
    // 入口先校验 as-of：无效时间戳必须 fail-loud，不能落进降级 catch 被吞。
    if (input.timestamp) cleanDate(input.timestamp, 'timestamp');
    const releaseForeground = options.qosClass === 'background'
      ? () => {}
      : beginForegroundActivity();
    const trace = this.createRetrievalTrace(input, options.traceContext);
    options.onTraceCreated?.(trace.traceId);
    let qualityState: 'full' | 'degraded' = 'degraded';
    try {
      let results = await this.recallReliableInternal(
        input,
        (quality) => {
          qualityState = quality;
        },
        trace,
        options,
      );
      if (
        results.length === 0 &&
        !options.qualityFallbackAttempted &&
        options.qualityFallback &&
        (!options.queryUnderstanding ||
          options.queryUnderstanding.status === 'not_needed')
      ) {
        let fallbackUnderstanding: QueryUnderstandingResult | null = null;
        trace.beginAttempt('quality_fallback');
        try {
          fallbackUnderstanding = await options.qualityFallback();
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          qualityState = 'degraded';
          trace.completeFailedStages(
            'quality_fallback_unavailable',
            message,
            {
              skipped: true,
              groundingState: 'degraded',
              injectedMemoryIds: [],
              actualTokens: 0,
            },
          );
          trace.finish({
            qualityState,
            resultCount: results.length,
            errorCode: 'quality_fallback_unavailable',
            detail: {
              error: message,
              resultIds: results.map((result) => result.memory.id),
            },
          });
          return results;
        }
        const fallbackUseful = hasQualityFallbackQueryDelta(
          input.query,
          fallbackUnderstanding,
        );
        if (fallbackUseful && fallbackUnderstanding) {
          results = await this.recallReliableInternal(
            input,
            (quality) => {
              qualityState = quality;
            },
            trace,
            {
              ...options,
              queryUnderstanding: fallbackUnderstanding,
              qualityFallbackAttempted: true,
            },
          );
        } else {
          trace.event('rewrite', {
            mode: 'contextual',
            triggered: true,
            ...queryUnderstandingTraceTelemetry(fallbackUnderstanding),
            qualityFallbackOutcome: 'not_useful',
            understandingStatus:
              fallbackUnderstanding?.status || 'empty',
            skipped: true,
            reason: fallbackUnderstanding?.status === 'resolved'
              ? 'quality_fallback_no_query_delta'
              : 'quality_fallback_not_useful',
          });
        }
      }
      trace.event('context', {
        skipped: true,
        reason: 'recall_only',
        injectedMemoryIds: [],
        actualTokens: 0,
      });
      trace.finish({
        qualityState,
        resultCount: results.length,
        detail: { resultIds: results.map((result) => result.memory.id) },
      });
      return results;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);
      trace.completeFailedStages(
        'semantic_recall_failed',
        message,
      );
      trace.finish({
        qualityState: 'unavailable',
        resultCount: 0,
        errorCode: 'semantic_recall_failed',
        detail: { error: message },
      });
      throw error;
    } finally {
      releaseForeground();
    }
  }

  private async recallReliableInternal(
    input: RecallInput,
    observeQuality?: (
      qualityState: 'full' | 'degraded',
    ) => void,
    trace?: RetrievalTraceSession,
    options: ReliableRecallOptions = {},
  ): Promise<RecallResult[]> {
    const understanding = options.queryUnderstanding;
    const clarificationRequired =
      understanding?.status === 'ambiguous' ||
      (
        understanding?.status === 'unavailable' &&
        understanding.triggerReasons.length > 0
      );
    if (understanding && clarificationRequired) {
      observeQuality?.(
        understanding.status === 'ambiguous' ? 'full' : 'degraded',
      );
      if (!trace) throw new Error('召回 trace 未初始化');
      trace.event('rewrite', {
        mode: 'contextual',
        triggered: true,
        ...queryUnderstandingTraceTelemetry(understanding),
        understandingStatus: understanding.status,
        triggerReasons: understanding.triggerReasons,
        contextSource: understanding.contextSource,
        decisionSource: understanding.decisionSource,
        resolvedReferenceCount: 0,
        unresolvedReferenceCount:
          understanding.unresolvedReferences.length,
        confidence: understanding.confidence,
        clarificationRequired: true,
        clarificationQuestion: understanding.clarificationQuestion,
        promptVersion: understanding.promptVersion,
        model: understanding.model,
        latencyMs: understanding.latencyMs,
        variants: [],
      });
      trace.event('channels', {
        queryVariantCount: 1,
        candidateCountByVariant: [{
          variantType: 'original',
          count: 0,
        }],
      });
      trace.event('fusion', {
        strategy: 'clarification_required',
        candidateCount: 0,
        candidates: [],
      });
      trace.event('semantic', {
        candidateCount: 0,
        reason: understanding.status === 'ambiguous'
          ? 'context_reference_ambiguous'
          : 'context_understanding_unavailable',
      });
      trace.event('rerank', {
        model: this.semanticRanker?.rerankModel || null,
        stages: [],
        attemptedCandidates: 0,
        decisions: [],
        skipped: true,
        reason: 'clarification_required',
      });
      trace.event('selection', {
        resultIds: [],
        reason: 'clarification_required',
      });
      return [];
    }
    if (!this.semanticRanker) {
      observeQuality?.('degraded');
      if (!trace) throw new Error('召回 trace 未初始化');
      return this.recallLocalInternal(input, trace);
    }

    const query = cleanText(input.query);
    if (!query) throw new Error('召回查询不能为空');
    const ownerId = cleanUserId(input.userId);
    const scopes = normalizeAccessScopes(input);
    const targetNamespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    // bi-temporal as-of：召回时间轴默认"现在"；显式传 input.timestamp（已由
    // cleanDate 校验）则按该时点过滤 valid_from/valid_to 与 superseded 可见性。
    // 本函数后续所有 timestamp 消费点均为只读查询（scope 过滤/图检索/水位核查），
    // 不存在以 timestamp 落库的写路径，复用同一时钟是安全的。
    const timestamp = input.timestamp
      ? cleanDate(input.timestamp, 'timestamp') || now()
      : now();
    const temporalPlan = temporalRetrievalPlan(
      query,
      understanding,
      timestamp,
    );
    // 代解析（2026-09-18）：优先跟随调用方命名空间的已激活代（写路径经
    // 固定评测后原子激活，召回必须使用该代及其 provider，模型不一致时
    // fail-closed 拒绝降级）。无激活代时按当前 provider 探测向量确定性
    // 派生——generationId 由 模型+LSH 版本+维度+探测指纹 决定、不含
    // userId，跨主体（A 写 → B 读）天然同代；并且只补齐 generation 全局
    // 行、绝不写 dense_index_aliases，纯读主体不在库里留状态。
    const alias = this.retrievalIndex.denseAlias(
      ownerId,
      targetNamespace,
    );
    let generation = alias?.activeGenerationId
      ? this.retrievalIndex.denseGenerationById(
          alias.activeGenerationId,
        )
      : null;
    let ranker = this.semanticRanker;
    if (generation) {
      const activeRanker =
        this.generationRankers.get(generation.generationId) ||
        this.semanticRankers.find(
          (candidate) =>
            candidate.embeddingModel ===
            generation!.embeddingModel,
        );
      if (!activeRanker) {
        throw new Error(
          `active Dense generation ${generation.generationId} 的 provider 不可用`,
        );
      }
      ranker = activeRanker;
    }
    const embeddingTelemetry: SemanticOperationTelemetry[] = [];
    let queryEmbeddings: Float32Array[];
    try {
      const embeddingInputs = [DENSE_GENERATION_PROBE, query];
      const embeddingStarted = performance.now();
      const operation = ranker.embedWithTelemetry
        ? await ranker.embedWithTelemetry(embeddingInputs)
        : null;
      queryEmbeddings = operation
        ? operation.result
        : await ranker.embed(embeddingInputs);
      embeddingTelemetry.push(
        operation?.telemetry || legacySemanticOperationTelemetry(
          'model',
          retrievalQueryHash(
            `${ranker.embeddingModel}\0embed\0` +
            embeddingInputs.map(retrievalQueryHash).join(','),
          ),
          Number((performance.now() - embeddingStarted).toFixed(3)),
          1,
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `可靠语义召回不可用，已拒绝降级：${message}`,
        { cause: error },
      );
    }
    if (
      queryEmbeddings.length !== 2 ||
      queryEmbeddings[0].length === 0 ||
      queryEmbeddings[1].length === 0 ||
      queryEmbeddings[0].length !== queryEmbeddings[1].length
    ) {
      throw new Error('可靠语义召回返回的查询向量不正确');
    }
    const probeVector = queryEmbeddings[0];
    const queryVector = queryEmbeddings[1];
    const generationKey = denseGenerationKey(probeVector);
    if (generation) {
      if (
        generation.embeddingModel !== ranker.embeddingModel ||
        generation.dimensions !== queryVector.length ||
        generation.generationKey !== generationKey ||
        alias?.activeGenerationId !== generation.generationId
      ) {
        throw new Error(
          '可靠语义召回的 provider 与 active Dense generation 不一致',
        );
      }
    } else {
      const identity = deriveDenseGenerationIdentity({
        embeddingModel: ranker.embeddingModel,
        dimensions: queryVector.length,
        generationKey,
      });
      generation =
        this.retrievalIndex.denseGenerationById(identity.generationId) ??
        this.retrievalIndex.ensureDenseGeneration({
          embeddingModel: ranker.embeddingModel,
          dimensions: queryVector.length,
          generationKey,
          timestamp,
        });
    }
    if (!trace) throw new Error('召回 trace 未初始化');
    const baseSearchInput: RecallInput = {
      ...input,
      query,
      scopes,
      scopeType: undefined,
      scopeKey: undefined,
    };
    const queryVariants: QueryVariant[] = [
      { query, type: 'original' },
    ];
    const queryVectors: Float32Array[] = [queryVector];
    const initialSearch = this.indexedRecallCandidates(
      baseSearchInput,
      ownerId,
      timestamp,
      {
        vector: queryVector,
        model: generation.embeddingModel,
        generationKey,
        generationId: generation.generationId,
      },
    );
    const candidateGroups: IndexedRecallCandidate[][] = [
      initialSearch.candidates,
    ];
    const diagnosticsByVariant: HybridSearchDiagnostics[] = [
      initialSearch.diagnostics,
    ];
    const contextualProposed: QueryVariant[] = understanding
      ? [
          ...(understanding.status === 'resolved' &&
              understanding.standaloneQuery
            ? [{
              query: cleanText(understanding.standaloneQuery),
              type: 'contextual' as const,
            }]
            : []),
          ...understanding.variants.map((variant) => ({
            query: cleanText(variant),
            type: 'contextual_variant' as const,
          })),
        ]
      : [];
    const understandingInvoked =
      understanding !== undefined &&
      (
        understanding.status !== 'not_needed' ||
        understanding.variants.length > 0
      );
    const initialCandidateCount = candidateGroups[0].length;
    const deterministicRewriteTriggered =
      initialCandidateCount < config.queryRewriteMinCandidates;
    const llmRewriteTriggered = initialCandidateCount === 0;
    const rewriteTriggered =
      contextualProposed.length > 0 ||
      deterministicRewriteTriggered;
    let rewriteError: string | null = null;
    let rewriteFailureCode: string | null = null;
    let semanticRewriteTelemetry: SemanticOperationTelemetry | null = null;
    if (
      contextualProposed.length > 0 ||
      rewriteTriggered
    ) {
      const proposed = [
        ...contextualProposed,
        ...deterministicQueryVariants(query).slice(1),
      ];
      if (
        config.queryRewriteMode === 'llm' &&
        ranker.rewrite &&
        !understandingInvoked &&
        llmRewriteTriggered
      ) {
        try {
          const rewriteStarted = performance.now();
          const operation = ranker.rewriteWithTelemetry
            ? await ranker.rewriteWithTelemetry(query)
            : null;
          const llm = operation
            ? operation.result
            : await ranker.rewrite(query);
          semanticRewriteTelemetry = operation?.telemetry ||
            legacySemanticOperationTelemetry(
              'model',
              retrievalQueryHash(
                `${ranker.rerankModel}\0rewrite\0${query}`,
              ),
              Number((performance.now() - rewriteStarted).toFixed(3)),
              1,
            );
          proposed.push(
            ...llm.map((variant): QueryVariant => ({
              query: cleanText(variant),
              type: 'llm',
            })),
          );
        } catch (error) {
          const failure = semanticOperationFailure(error);
          semanticRewriteTelemetry = failure?.telemetry || null;
          rewriteFailureCode = failure?.code || null;
          rewriteError = error instanceof Error
            ? error.message
            : String(error);
        }
      }
      for (const variant of proposed) {
        if (!variant.query) continue;
        if (
          queryVariants.some(
            (existing) => existing.query === variant.query,
          )
        ) continue;
        queryVariants.push(variant);
        if (queryVariants.length >= config.maxQueryVariants) break;
      }
      if (queryVariants.length > 1) {
        let variantVectors: Float32Array[];
        try {
          const variantInputs = queryVariants
            .slice(1)
            .map((variant) => variant.query);
          const embeddingStarted = performance.now();
          const operation = ranker.embedWithTelemetry
            ? await ranker.embedWithTelemetry(variantInputs)
            : null;
          variantVectors = operation
            ? operation.result
            : await ranker.embed(variantInputs);
          embeddingTelemetry.push(
            operation?.telemetry || legacySemanticOperationTelemetry(
              'model',
              retrievalQueryHash(
                `${ranker.embeddingModel}\0embed\0` +
                variantInputs.map(retrievalQueryHash).join(','),
              ),
              Number((performance.now() - embeddingStarted).toFixed(3)),
              1,
            ),
          );
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          throw new Error(
            `可靠语义查询扩展不可用，已拒绝部分向量：${message}`,
            { cause: error },
          );
        }
        if (
          variantVectors.length !== queryVariants.length - 1 ||
          variantVectors.some(
            (vector) => vector.length !== queryVector.length,
          )
        ) {
          throw new Error('可靠语义查询扩展返回的向量不正确');
        }
        queryVectors.push(...variantVectors);
        for (let index = 1; index < queryVariants.length; index += 1) {
          const variantSearch = this.indexedRecallCandidates(
            {
              ...baseSearchInput,
              query: queryVariants[index].query,
            },
            ownerId,
            timestamp,
            {
              vector: queryVectors[index],
              model: generation.embeddingModel,
              generationKey,
              generationId: generation.generationId,
            },
          );
          candidateGroups.push(variantSearch.candidates);
          diagnosticsByVariant.push(variantSearch.diagnostics);
        }
      }
    }
    const rewriteTraceTelemetry = understandingInvoked
      ? queryUnderstandingTraceTelemetry(understanding)
      : semanticOperationTraceTelemetry(
        semanticRewriteTelemetry || legacySemanticOperationTelemetry(
          'deterministic_fast',
          retrievalQueryHash(
            `${ranker.rerankModel}\0rewrite-skipped\0${query}`,
          ),
          0,
          0,
        ),
      );
    trace.event('rewrite', {
      mode: understandingInvoked
        ? 'contextual'
        : config.queryRewriteMode === 'llm' &&
            Boolean(ranker.rewrite) &&
            llmRewriteTriggered
          ? 'llm'
          : rewriteTriggered
            ? 'deterministic'
            : config.queryRewriteMode,
      triggered: rewriteTriggered,
      deterministicTriggered: deterministicRewriteTriggered,
      llmTriggered:
        config.queryRewriteMode === 'llm' &&
        Boolean(ranker.rewrite) &&
        !understandingInvoked &&
        llmRewriteTriggered,
      initialCandidateCount,
      minCandidateThreshold: config.queryRewriteMinCandidates,
      ...rewriteTraceTelemetry,
      queryDelta: queryVariants.some(
        (variant) => cleanText(variant.query) !== query,
      ),
      variantDelta: queryVariants.length > 1,
      rewriteError,
      failureCode: rewriteFailureCode,
      variants: queryVariants,
      understandingStatus: understanding?.status || 'not_requested',
      triggerReasons: understanding?.triggerReasons || [],
      contextSource: understanding?.contextSource || 'none',
      decisionSource: understanding?.decisionSource || 'none',
      resolvedReferenceCount:
        understanding?.resolvedReferences.length || 0,
      unresolvedReferenceCount:
        understanding?.unresolvedReferences.length || 0,
      confidence: understanding?.confidence || 0,
      clarificationRequired: false,
      standaloneQuery: understanding?.standaloneQuery || null,
      standaloneQueryHash: understanding?.standaloneQuery
        ? retrievalQueryHash(understanding.standaloneQuery)
        : null,
      promptVersion: understanding?.promptVersion ||
        (ranker.rewrite ? 'query-rewrite-v1' : null),
      model: understanding
        ? understanding.model
        : ranker.rewrite ? ranker.rerankModel : null,
      latencyMs: understanding?.latencyMs || 0,
    });
    let indexedCandidates = this.mergeIndexedRecallCandidates(
      candidateGroups,
    );
    const graphSearch = this.retrievalIndex.expandGraphWithDiagnostics(
      {
        query,
        userId: ownerId,
        namespace: input.namespace,
        kinds: input.kinds,
        tags: cleanTags(input.tags),
        includeArchived: input.includeArchived,
        scopes,
        clearance: input.clearance,
        allowedSensitivities: input.allowedSensitivities,
        timestamp,
      },
      indexedCandidates
        .slice(0, Math.min(16, indexedCandidates.length))
        .map((candidate) => candidate.memory.id),
      config.graphCandidateLimit,
    );
    const graphCandidates = graphSearch.candidates;
    if (graphCandidates.length > 0) {
      indexedCandidates = this.mergeIndexedRecallCandidates([
        indexedCandidates,
        this.hydrateIndexedRecallCandidates(
          graphCandidates,
          'graph-expansion',
        ),
      ]);
    }
    trace.event('channels', {
      queryVariantCount: queryVariants.length,
      candidateCountByVariant: candidateGroups.map(
        (group, index) => ({
          variantType: queryVariants[index].type,
          count: group.length,
        }),
      ),
      diagnosticsByVariant: diagnosticsByVariant.map(
        (diagnostics, index) => ({
          variantType: queryVariants[index].type,
          annMode: diagnostics.annMode,
          perChannelLimit: diagnostics.perChannelLimit,
          channels: diagnostics.channels,
        }),
      ),
      truncationSummary: [
        {
          reasonCode: 'lexical_channel_cap',
          count: diagnosticsByVariant.reduce(
            (total, item) => total + item.channels.lexical.cappedCount,
            0,
          ),
        },
        {
          reasonCode: 'ann_channel_cap',
          count: diagnosticsByVariant.reduce(
            (total, item) => total + item.channels.ann.cappedCount,
            0,
          ),
        },
        {
          reasonCode: 'term_channel_cap',
          count: diagnosticsByVariant.reduce(
            (total, item) => total + item.channels.term.cappedCount,
            0,
          ),
        },
        {
          reasonCode: 'graph_channel_cap',
          count: graphSearch.diagnostics.cappedCount,
        },
      ].filter((item) => item.count > 0),
      graphDiagnostics: graphSearch.diagnostics,
      lexicalCandidateCount: indexedCandidates.filter(
        ({ retrieval }) => retrieval.lexicalRank !== null,
      ).length,
      annCandidateCount: indexedCandidates.filter(
        ({ retrieval }) => retrieval.annRank !== null,
      ).length,
      termCandidateCount: indexedCandidates.filter(
        ({ retrieval }) => retrieval.termRank !== null,
      ).length,
      graphCandidateCount: indexedCandidates.filter(
        ({ retrieval }) => retrieval.graphRank !== null,
      ).length,
      candidateIds: indexedCandidates.map(
        (candidate) => candidate.memory.id,
      ),
    });
    trace.event('fusion', {
      strategy: 'multi-query-rrf-plus-one-hop-graph',
      candidateCount: indexedCandidates.length,
      diagnosticsByVariant: diagnosticsByVariant.map(
        (diagnostics, index) => ({
          variantType: queryVariants[index].type,
          limit: diagnostics.limit,
          fusion: diagnostics.fusion,
        }),
      ),
      truncationSummary: [{
        reasonCode: 'fusion_candidate_cap',
        count: diagnosticsByVariant.reduce(
          (total, item) => total + item.fusion.cappedCount,
          0,
        ),
      }, {
        reasonCode: 'invalid_derived_source',
        count: diagnosticsByVariant.reduce(
          (total, item) =>
            total + item.fusion.invalidDerivedSourceCount,
          0,
        ),
      }].filter((item) => item.count > 0),
      candidates: indexedCandidates.map((candidate) => ({
        memoryId: candidate.memory.id,
        fusedScore: Number(candidate.retrieval.fusedScore.toFixed(6)),
        variantHitCount: candidate.queryVariantHits.length,
        graphRank: candidate.retrieval.graphRank,
      })),
    });
    const candidates = indexedCandidates
      .map(({
        memory,
        semanticRevision,
        retrieval,
        queryVariantHits,
      }) => {
        const text = semanticMemoryText(memory);
        return {
          memory,
          semanticRevision,
          retrieval,
          queryVariantHits,
          text,
          textHash: semanticTextHash(text),
        };
      });

    if (candidates.length === 0) {
      const watermark = this.retrievalIndex.denseWatermark({
        userId: ownerId,
        namespace: targetNamespace,
        generationId: generation.generationId,
        embeddingModel: generation.embeddingModel,
        timestamp,
        dimensions: queryVector.length,
        generationKey,
        includeArchived: input.includeArchived,
        scopes,
        clearance: input.clearance,
        allowedSensitivities:
          input.allowedSensitivities || ['normal'],
        verifyLshBands: false,
        includeForeignGenerations: true,
      });
      // 禁止静默降级：稠密通道为 0 且该可见范围下确有可召回内容时，
      // 必须区分"尚未索引"与"代错配"（如换模型后旧文档仍挂在旧代）。
      const denseCoverageReason = watermark.indexed === 0 &&
          watermark.eligible > 0
        ? watermark.foreignGenerations.length > 0
          ? 'dense-generation-mismatch'
          : 'dense-index-incomplete'
        : null;
      observeQuality?.(
        watermark.complete && !denseCoverageReason ? 'full' : 'degraded',
      );
      this.audit('recall', null, ownerId, {
        traceId: trace.traceId,
        queryHash: retrievalQueryHash(query),
        query: config.retrievalLogMode === 'diagnostic'
          ? query
          : undefined,
        mode: 'hybrid-semantic',
        qualityState: watermark.complete ? 'full' : 'degraded',
        denseCoverageReason,
        denseForeignGenerations: watermark.foreignGenerations,
        embeddingModel: generation.embeddingModel,
        rerankModel: ranker.rerankModel,
        denseEligible: watermark.eligible,
        denseIndexed: watermark.indexed,
        indexVersion: DENSE_LSH_VERSION,
        generationId: generation.generationId,
        generationKey,
        candidateCount: 0,
        lexicalCandidateCount: 0,
        annCandidateCount: 0,
        termCandidateCount: 0,
        graphCandidateCount: 0,
        rerankCandidateCount: 0,
        filterSummary: [],
        resultIds: [],
        resultDetails: [],
      });
      trace.event('semantic', {
        embeddingModel: generation.embeddingModel,
        denseEligible: watermark.eligible,
        denseIndexed: watermark.indexed,
        candidateCount: 0,
        reason: denseCoverageReason ||
          'all_query_variants_returned_zero_candidates',
      });
      trace.event('rerank', {
        model: ranker.rerankModel,
        minConfidence: config.semanticMinConfidence,
        stages: [],
        attemptedCandidates: 0,
        candidateCapFilteredCount: 0,
        decisions: [],
        skipped: true,
        reason: 'zero_candidates_after_rewrite',
      });
      trace.event('selection', {
        resultIds: [],
        reason: 'zero_candidates_after_rewrite',
        candidateDecisions: [],
      });
      return [];
    }

    const ids = candidates.map(({ memory }) => memory.id);
    const compactedCandidateIds = new Set(
      (this.database.prepare(
        `SELECT memory_id
         FROM conversation_episode_compactions
         WHERE memory_id IN (${ids.map(() => '?').join(', ')})`,
      ).all(...ids) as DatabaseRow[])
        .map((row) => asString(row.memory_id)),
    );
    const cachedRows = this.database
      .prepare(
        `SELECT memory_id, text_hash, dimensions, generation_key,
                memory_revision, embedding
         FROM memory_embeddings
         WHERE generation_id = ?
           AND memory_id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(
        generation.generationId,
        ...ids,
      ) as DatabaseRow[];
    const cached = new Map(
      cachedRows.map((row) => [asString(row.memory_id), row]),
    );
    const vectors = new Map<string, Float32Array>();
    const missing = candidates.filter((candidate) => {
      if (compactedCandidateIds.has(candidate.memory.id)) return true;
      const row = cached.get(candidate.memory.id);
      if (
        !row ||
        asString(row.text_hash) !== candidate.textHash ||
        asString(row.generation_key) !== generationKey ||
        Number(row.memory_revision) !==
          candidate.semanticRevision ||
        !(row.embedding instanceof Uint8Array)
      ) {
        return true;
      }
      const vector = bufferToVector(row.embedding);
      if (
        vector.length === 0 ||
        vector.length !== Number(row.dimensions) ||
        vector.length !== queryVector.length
      ) {
        return true;
      }
      vectors.set(candidate.memory.id, vector);
      return false;
    });

    let embedded: Float32Array[] = [];
    if (missing.length > 0) {
      try {
        const missingInputs = missing.map((candidate) => candidate.text);
        const embeddingStarted = performance.now();
        const operation = ranker.embedWithTelemetry
          ? await ranker.embedWithTelemetry(missingInputs)
          : null;
        embedded = operation
          ? operation.result
          : await ranker.embed(missingInputs);
        embeddingTelemetry.push(
          operation?.telemetry || legacySemanticOperationTelemetry(
            'model',
            retrievalQueryHash(
              `${ranker.embeddingModel}\0embed\0` +
              missingInputs.map(retrievalQueryHash).join(','),
            ),
            Number((performance.now() - embeddingStarted).toFixed(3)),
            1,
          ),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `可靠语义召回不可用，已拒绝降级：${message}`,
          { cause: error },
        );
      }
      if (
        embedded.length !== missing.length ||
        embedded.some(
          (vector) => vector.length !== queryVector.length,
        )
      ) {
        throw new Error('可靠语义召回返回的候选向量不正确');
      }
      for (let index = 0; index < missing.length; index += 1) {
        vectors.set(missing[index].memory.id, embedded[index]);
      }
    }

    const needsDenseIndex = candidates.filter((candidate) => {
      if (compactedCandidateIds.has(candidate.memory.id)) return false;
      return !this.retrievalIndex.isDenseIndexed(
        candidate.memory.id,
        generation.generationId,
        generation.embeddingModel,
        candidate.textHash,
        candidate.memory.updatedAt,
        queryVector.length,
        candidate.semanticRevision,
        generationKey,
      );
    });
    if (missing.length > 0 || needsDenseIndex.length > 0) {
      const upsert = this.database.prepare(
        `INSERT INTO memory_embeddings (
           memory_id, generation_id, model, text_hash, dimensions,
           generation_key, memory_revision, embedding, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id, generation_id) DO UPDATE SET
           model = excluded.model,
           text_hash = excluded.text_hash,
           dimensions = excluded.dimensions,
           generation_key = excluded.generation_key,
           memory_revision = excluded.memory_revision,
           embedding = excluded.embedding,
           updated_at = excluded.updated_at`,
      );
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const currentRevision = this.database.prepare(
          `SELECT semantic_revision
           FROM memories
           WHERE id = ?`,
        );
        for (let index = 0; index < missing.length; index += 1) {
          const candidate = missing[index];
          const vector = embedded[index];
          if (compactedCandidateIds.has(candidate.memory.id)) continue;
          if (
            Number(
              currentRevision.get(candidate.memory.id)
                ?.semantic_revision,
            ) !== candidate.semanticRevision
          ) {
            continue;
          }
          upsert.run(
            candidate.memory.id,
            generation.generationId,
            generation.embeddingModel,
            candidate.textHash,
            vector.length,
            generationKey,
            candidate.semanticRevision,
            vectorToBuffer(vector),
            candidate.memory.updatedAt,
          );
        }
        for (const candidate of needsDenseIndex) {
          const vector = vectors.get(candidate.memory.id);
          if (!vector) {
            throw new Error(
              `记忆 ${candidate.memory.id} 缺少 dense embedding`,
            );
          }
          if (
            Number(
              currentRevision.get(candidate.memory.id)
                ?.semantic_revision,
            ) !== candidate.semanticRevision
          ) {
            continue;
          }
          this.retrievalIndex.upsertDense(
            candidate.memory.id,
            generation.generationId,
            generation.embeddingModel,
            candidate.textHash,
            vector,
            candidate.memory.updatedAt,
            candidate.semanticRevision,
            generationKey,
          );
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }

    const currentRevision = this.database.prepare(
      `SELECT semantic_revision
       FROM memories
       WHERE id = ?`,
    );
    const freshCandidates = candidates.filter(
      (candidate) =>
        Number(
          currentRevision.get(candidate.memory.id)?.semantic_revision,
        ) === candidate.semanticRevision,
    );
    const temporalEvidenceDigests = temporalPlan
      ? this.memoryEvidenceDigests(
          freshCandidates.map((candidate) => candidate.memory.id),
          ownerId,
        )
      : null;
    const scoredCandidates = freshCandidates
      .map((candidate) => {
        const vector = vectors.get(candidate.memory.id);
        if (!vector) {
          throw new Error(`记忆 ${candidate.memory.id} 缺少语义向量`);
        }
        const semanticScore = Math.max(
          ...queryVectors.map((candidateVector) =>
            cosineSimilarity(candidateVector, vector),
          ),
        );
        const channelScore = Math.min(
          1,
          candidate.retrieval.fusedScore * 30,
        );
        const temporalSignal = temporalCandidateSignal(
          temporalPlan,
          candidate.memory,
          temporalEvidenceDigests?.get(candidate.memory.id),
        );
        const baseCoarseScore =
          semanticScore * 0.85 + channelScore * 0.15;
        const coarseScore = temporalPlan
          ? baseCoarseScore * 0.85 +
            (temporalSignal?.score || 0) * 0.15
          : baseCoarseScore;
        return {
          ...candidate,
          semanticScore,
          channelScore,
          temporalSignal,
          coarseScore,
        };
      });
    const similarityQualified = scoredCandidates
      .filter(
        ({ semanticScore, text }) =>
          semanticScore >= config.semanticMinSimilarity ||
          Math.max(
            ...queryVariants.map((variant) =>
              tokenOverlap(variant.query, text),
            ),
          ) >= 0.3,
      )
      .sort(
        (left, right) =>
          right.coarseScore - left.coarseScore,
      );
    const similarityFilteredCount =
      scoredCandidates.length - similarityQualified.length;
    const similarityQualifiedIds = new Set(
      similarityQualified.map((candidate) => candidate.memory.id),
    );
    const candidateDecisions: RetrievalCandidateDecision[] =
      scoredCandidates
        .filter(
          (candidate) => !similarityQualifiedIds.has(candidate.memory.id),
        )
        .map((candidate) => ({
          memoryId: candidate.memory.id,
          stage: 'semantic',
          decision: 'rejected',
          evaluated: true,
          reasonCode: 'semantic_below_threshold',
          score: Number(candidate.semanticScore.toFixed(6)),
          threshold: config.semanticMinSimilarity,
        }));
    const rankingQuery = understanding?.status === 'resolved'
      ? cleanText(understanding.rankingQuery, query)
      : understanding?.variants[0]
        ? cleanText(understanding.variants[0], query)
      : query;
    const providerRankingQuery = boundedProviderRankingQuery(rankingQuery);
    const explicitVerbatimUserEvidence =
      isExplicitVerbatimUserEvidenceQuery(query, rankingQuery);
    const resultLimit = Math.max(
      1,
      Math.min(input.limit || 8, 30),
    );
    const atomicSingleValueQuery = isExplicitAtomicSingleValueQuery(
      rankingQuery,
      understanding,
    );
    const atomicProfileRule = atomicSingleValueQuery
      ? deterministicAtomicProfileQueryRule(atomicQueryVariant(rankingQuery))
      : null;
    const stableAtomicProfileQuery = Boolean(
      atomicProfileRule && STABLE_ATOMIC_PROFILE_RULES.has(atomicProfileRule),
    );
    const atomicValueVerification = atomicSingleValueQuery &&
      ATOMIC_VALUE_VERIFICATION_QUERY_PATTERN.test(rankingQuery);
    const explicitExhaustiveQuery = isExplicitExhaustiveRecallQuery(
      query,
      understanding,
    );
    const desiredRelevant = atomicSingleValueQuery &&
        !explicitExhaustiveQuery
      ? 1
      : Math.min(resultLimit, 4);
    const visibleScopeSql = scopes.map(
      () => '(i.scope_type = ? AND i.scope_key = ?)',
    ).join(' OR ');
    const visibleScopeValues = scopes.flatMap(
      ({ scopeType, scopeKey }) => [scopeType, scopeKey],
    );
    const canonicalAuthorizedIds = similarityQualified.map(
      (candidate) => candidate.memory.id,
    );
    const canonicalRows = stableAtomicProfileQuery &&
        canonicalAuthorizedIds.length > 0
      ? this.database.prepare(
          `SELECT m.*, i.predicate_key AS item_predicate_key,
                  i.normalized_value_hash AS item_value_hash,
                  i.normalized_value AS item_normalized_value,
                  i.predicate_cardinality AS item_cardinality,
                  v.predicate_key AS version_predicate_key,
                  v.normalized_value_hash AS version_value_hash,
                  v.normalized_value AS version_normalized_value,
                  v.predicate_cardinality AS version_cardinality,
                  v.negated AS version_negated,
                  v.superseded_at AS version_superseded_at
           FROM memory_items i
           JOIN memory_versions v ON v.id = i.current_version_id
           JOIN memories m ON m.id = i.id
           WHERE i.user_id = ? AND i.namespace = ?
             AND i.status = 'active' AND m.status = 'active'
             AND i.current_version_id = v.id
             AND v.superseded_at IS NULL AND v.negated = 0
             AND i.source_authority IN ('direct_user', 'user_confirmed')
             AND v.source_authority IN ('direct_user', 'user_confirmed')
             AND m.confidence >= ?
             AND (m.valid_from IS NULL OR m.valid_from <= ?)
             AND (m.valid_to IS NULL OR m.valid_to > ?)
             AND (i.expires_at IS NULL OR i.expires_at > ?)
             AND (${visibleScopeSql})
             AND i.id IN (${canonicalAuthorizedIds.map(
               () => '?',
             ).join(', ')})`,
        ).all(
          ownerId,
          targetNamespace,
          RERANK_HIGH_CONFIDENCE,
          timestamp,
          timestamp,
          timestamp,
          ...visibleScopeValues,
          ...canonicalAuthorizedIds,
        ) as DatabaseRow[]
      : [];
    const matchingCanonicalRows = canonicalRows.filter((row) => {
      if (!similarityQualifiedIds.has(asString(row.id))) return false;
      const itemPredicate = asString(row.item_predicate_key).trim();
      const versionPredicate = asString(
        row.version_predicate_key,
      ).trim();
      const itemValue = asString(row.item_value_hash).trim();
      const versionValue = asString(row.version_value_hash).trim();
      const itemNormalizedValue = asString(
        row.item_normalized_value,
      ).trim();
      const versionNormalizedValue = asString(
        row.version_normalized_value,
      ).trim();
      return itemPredicate.length > 0 &&
        itemPredicate === versionPredicate &&
        itemValue.length > 0 &&
        itemValue === versionValue &&
        itemNormalizedValue.length > 0 &&
        itemNormalizedValue === versionNormalizedValue &&
        deterministicAtomicProfilePredicateMatches(
          rankingQuery,
          itemPredicate,
        );
    });
    const maximumCanonicalScopePriority = matchingCanonicalRows.reduce(
      (maximum, row) => Math.max(
        maximum,
        SCOPE_PRECEDENCE[
          (asString(row.scope_type) as MemoryRecord['scopeType']) ||
            'personal'
        ],
      ),
      Number.NEGATIVE_INFINITY,
    );
    const highestScopeCanonicalRows = matchingCanonicalRows.filter((row) =>
      SCOPE_PRECEDENCE[
        (asString(row.scope_type) as MemoryRecord['scopeType']) ||
          'personal'
      ] === maximumCanonicalScopePriority
    );
    const matchingVerificationRows = atomicValueVerification
      ? highestScopeCanonicalRows.filter((row) =>
          atomicValueClearlyMatchesQuery(
            rankingQuery,
            asString(row.item_normalized_value),
          )
        )
      : highestScopeCanonicalRows;
    const canonicalVerificationAbstention = atomicValueVerification &&
      highestScopeCanonicalRows.length > 0 &&
      matchingVerificationRows.length === 0 &&
      atomicValuesClearlyConflictWithQuery(
        rankingQuery,
        highestScopeCanonicalRows.map((row) =>
          asString(row.item_normalized_value)),
      );
    const canonicalIdentityRows = atomicValueVerification
      ? matchingVerificationRows
      : highestScopeCanonicalRows;
    const canonicalIdentity = (row: DatabaseRow) =>
      `${atomicProfileRule || asString(row.item_predicate_key)}\0${
        asString(row.item_value_hash)
      }`;
    const canonicalDatabaseIdentities = new Set(
      canonicalIdentityRows.map(canonicalIdentity),
    );
    const canonicalCandidateByIdentity = new Map<string, (
      typeof similarityQualified
    )[number]>();
    for (const row of canonicalIdentityRows) {
      const candidate = similarityQualified.find((item) =>
        item.memory.id === asString(row.id)
      );
      if (candidate && !canonicalCandidateByIdentity.has(
        canonicalIdentity(row),
      )) {
        canonicalCandidateByIdentity.set(canonicalIdentity(row), candidate);
      }
    }
    const canonicalDatabaseCandidates = atomicProfileRule === 'food_aversion'
      ? [...canonicalCandidateByIdentity.values()]
      : canonicalDatabaseIdentities.size === 1
        ? [...canonicalCandidateByIdentity.values()].slice(0, 1)
        : [];
    const activeAtomicTombstone = atomicSingleValueQuery &&
        highestScopeCanonicalRows.length === 0
      ? (this.database.prepare(
          `SELECT normalized_key
           FROM memory_tombstones
           WHERE user_id = ? AND namespace = ?
             AND restored_at IS NULL
             AND (${scopes.map(
               () => '(scope_type = ? AND scope_key = ?)',
             ).join(' OR ')})`,
        ).all(
          ownerId,
          targetNamespace,
          ...visibleScopeValues,
        ) as DatabaseRow[]).some((row) =>
          deterministicAtomicProfilePredicateMatches(
            rankingQuery,
            asString(row.normalized_key),
          )
        )
      : false;
    const deterministicExact = deterministicExactIdentifierCandidate(
      rankingQuery,
      similarityQualified,
    );
    const deterministicCandidates = deterministicExact
      ? [deterministicExact.candidate]
      : canonicalDatabaseCandidates;
    const deterministicCandidate = deterministicCandidates[0] || null;
    const rerankCandidates = deterministicCandidates.length > 0
      ? [
          ...deterministicCandidates,
          ...similarityQualified.filter(
            (candidate) => !deterministicCandidates.includes(candidate),
          ),
        ]
      : similarityQualified;
    // 语料域分档门槛（v42）：逐候选按 memories.corpus_domain 查表；
    // 未标注条目沿用全局 semanticMinConfidence，行为与旧版一致。
    const corpusGateById = new Map<string, number>();
    for (const candidate of rerankCandidates) {
      const domain = candidate.memory.corpusDomain;
      const gate = domain === 'policy'
        ? config.rerankGatePolicy
        : domain === 'open'
        ? config.rerankGateOpen
        : domain === 'chat'
        ? config.rerankGateChat
        : config.semanticMinConfidence;
      corpusGateById.set(candidate.memory.id, gate);
    }
    const rerankGateFor = (memoryId: string): number =>
      corpusGateById.get(memoryId) ?? config.semanticMinConfidence;
    const rerankEvidenceDigests = temporalEvidenceDigests
      ? new Map(temporalEvidenceDigests)
      : new Map<string, MemoryEvidenceDigest>();
    const ensureRerankEvidenceDigests = (
      memoryIds: readonly string[],
    ): void => {
      const missingIds = [...new Set(memoryIds)].filter(
        (memoryId) => !rerankEvidenceDigests.has(memoryId),
      );
      if (missingIds.length === 0) return;
      for (const [memoryId, digest] of this.memoryEvidenceDigests(
        missingIds,
        ownerId,
      )) {
        rerankEvidenceDigests.set(memoryId, digest);
      }
    };
    if (deterministicCandidates.length > 0) {
      ensureRerankEvidenceDigests(
        deterministicCandidates.map((candidate) => candidate.memory.id),
      );
    }
    const expansionStages = [16, 32, 64]
      .map((value) =>
        Math.min(value, config.semanticMaxRerankCandidates),
      )
      .filter(
        (value, index, values) =>
          value > 0 && values.indexOf(value) === index,
      );
    if (expansionStages.length === 0) {
      expansionStages.push(config.semanticMaxRerankCandidates);
    }
    const embeddingAttemptTelemetry = embeddingTelemetry.map(
      semanticOperationTraceTelemetry,
    );
    const embeddingProviderDurationMs = embeddingTelemetry.reduce(
      (total, telemetry) => total + (telemetry.providerDurationMs || 0),
      0,
    );
    trace.event('semantic', {
      embeddingModel: generation.embeddingModel,
      route: embeddingTelemetry.some(
        (telemetry) => telemetry.route === 'model',
      )
        ? 'model'
        : embeddingTelemetry.some(
          (telemetry) => telemetry.route === 'cache',
        )
          ? 'cache'
          : 'deterministic_fast',
      providerCalls: embeddingTelemetry.reduce(
        (total, telemetry) => total + telemetry.providerCalls,
        0,
      ),
      cacheHit: embeddingTelemetry.some((telemetry) => telemetry.cacheHit),
      singleFlightShared: embeddingTelemetry.some(
        (telemetry) => telemetry.singleFlightShared,
      ),
      keyFingerprint: embeddingTelemetry.length === 1
        ? embeddingTelemetry[0].keyFingerprint
        : null,
      requestDurationMs: Number(embeddingTelemetry.reduce(
        (total, telemetry) => total + telemetry.requestDurationMs,
        0,
      ).toFixed(3)),
      providerDurationMs: embeddingProviderDurationMs > 0
        ? Number(embeddingProviderDurationMs.toFixed(3))
        : null,
      modelTelemetry: embeddingTelemetry.length === 1
        ? embeddingTelemetry[0].model
        : null,
      attempts: embeddingAttemptTelemetry,
      minSimilarity: config.semanticMinSimilarity,
      scoredCandidateCount: scoredCandidates.length,
      qualifiedCandidateCount: similarityQualified.length,
      filteredCandidateCount: similarityFilteredCount,
      queryVariantCount: queryVectors.length,
      temporalIntent: temporalPlan
        ? {
            kind: temporalPlan.kind,
            label: temporalPlan.label,
            rangeStartAt: temporalPlan.rangeStartMs === null
              ? null
              : new Date(temporalPlan.rangeStartMs).toISOString(),
            rangeEndAt: temporalPlan.rangeEndMs === null
              ? null
              : new Date(temporalPlan.rangeEndMs).toISOString(),
          }
        : null,
      temporalScoredCandidateCount: temporalPlan
        ? scoredCandidates.filter(
            (candidate) => candidate.temporalSignal !== null,
          ).length
        : 0,
    });
    let attemptedCandidates = 0;
    const decisions = [] as Awaited<
      ReturnType<SemanticRanker['rerank']>
    >;
    const rerankStages: Array<{
      from: number;
      to: number;
      relevant: number;
    }> = [];
    const rerankTelemetry: SemanticOperationTelemetry[] = [];
    let relevantCount = 0;
    let effectiveRelevantAnswerCount = 0;
    let sufficientRelevantStopped = false;
    let coarseScoreCliffRatio: number | null = null;
    let coarseScoreCliffStopped = false;
    let canonicalRelevantAnswerCount = 0;
    let canonicalRelevantPredicates = new Set<string>();
    let canonicalRelevantIdentities = new Set<string>();
    let relevantCanonicalSelectionIdentityById = new Map<string, string>();
    const canonicalRowsFor = (memoryIds: readonly string[]) => {
      if (memoryIds.length === 0) return [] as DatabaseRow[];
      return this.database.prepare(
        `SELECT i.id, i.predicate_key, i.normalized_value_hash,
                i.predicate_cardinality, i.status AS item_status,
                i.current_version_id, v.id AS version_id,
                v.predicate_key AS version_predicate_key,
                v.normalized_value_hash AS version_value_hash,
                v.predicate_cardinality AS version_cardinality,
                v.superseded_at, m.status AS memory_status,
                i.scope_type, i.scope_key
         FROM memory_items i
         JOIN memory_versions v ON v.id = i.current_version_id
         JOIN memories m ON m.id = i.id
         WHERE i.id IN (${memoryIds.map(() => '?').join(', ')})`,
      ).all(...memoryIds) as DatabaseRow[];
    };
    const activeSingleCanonicalRows = (memoryIds: readonly string[]) =>
      canonicalRowsFor(memoryIds).filter((row) => {
        const itemPredicate = asString(row.predicate_key).trim();
        const versionPredicate = asString(
          row.version_predicate_key,
        ).trim();
        const itemValue = asString(row.normalized_value_hash).trim();
        const versionValue = asString(row.version_value_hash).trim();
        return asString(row.item_status) === 'active' &&
          asString(row.memory_status) === 'active' &&
          asString(row.current_version_id) === asString(row.version_id) &&
          !asNullableString(row.superseded_at) &&
          itemPredicate.length > 0 &&
          itemPredicate === versionPredicate &&
          itemValue.length > 0 &&
          itemValue === versionValue &&
          asString(row.predicate_cardinality) === 'single' &&
          asString(row.version_cardinality) === 'single';
      });
    if (deterministicExact) {
      const candidate = deterministicExact.candidate;
      decisions.push({
        id: candidate.memory.id,
        relevant: true,
        confidence: 1,
        reason: '确定性标识符唯一精确命中',
      });
      attemptedCandidates = 1;
      relevantCount = 1;
      effectiveRelevantAnswerCount = 1;
      rerankStages.push({ from: 0, to: 1, relevant: 1 });
      rerankTelemetry.push(legacySemanticOperationTelemetry(
        'deterministic_fast',
        retrievalQueryHash(
          `exact-identifier\0${deterministicExact.identifier}\0` +
          candidate.memory.id,
        ),
        0,
        0,
      ));
    } else if (canonicalDatabaseCandidates.length > 0) {
      decisions.push(...canonicalDatabaseCandidates.map((candidate) => ({
        id: candidate.memory.id,
        relevant: true,
        confidence: 1,
        reason: 'deterministic_canonical_single_value',
      })));
      attemptedCandidates = canonicalDatabaseCandidates.length;
      relevantCount = canonicalDatabaseCandidates.length;
      effectiveRelevantAnswerCount = canonicalDatabaseIdentities.size;
      canonicalRelevantAnswerCount = canonicalDatabaseIdentities.size;
      canonicalRelevantIdentities = new Set(canonicalDatabaseIdentities);
      canonicalRelevantPredicates = new Set(
        highestScopeCanonicalRows.map((row) =>
          asString(row.item_predicate_key)),
      );
      rerankStages.push({
        from: 0,
        to: canonicalDatabaseCandidates.length,
        relevant: canonicalDatabaseCandidates.length,
      });
      rerankTelemetry.push(legacySemanticOperationTelemetry(
        'deterministic_fast',
        retrievalQueryHash(
          `canonical-single-value\0${rankingQuery}\0` +
          canonicalDatabaseCandidates.map((candidate) =>
            candidate.memory.id).join(','),
        ),
        0,
        0,
      ));
    }
    const rerankStageLimits = expansionStages;
    for (const stageLimit of
      deterministicCandidate || activeAtomicTombstone ||
        canonicalVerificationAbstention
        ? []
        : rerankStageLimits) {
      const to = Math.min(stageLimit, rerankCandidates.length);
      if (to <= attemptedCandidates) continue;
      const batch = rerankCandidates.slice(attemptedCandidates, to);
      ensureRerankEvidenceDigests(
        batch.map((candidate) => candidate.memory.id),
      );
      let stageDecisions;
      try {
        const semanticCandidates = applyRerankCandidateTextBudget(
          batch.map(({ memory }) => {
            const evidenceDigest = rerankEvidenceDigests.get(memory.id);
            return {
              id: memory.id,
              kind: memory.kind,
              memory: semanticRerankText(
                memory,
                evidenceDigest,
                explicitVerbatimUserEvidence,
              ),
              evidence: semanticCandidateEvidence(memory, evidenceDigest),
            };
          }),
        );
        // 按内容类型隔离分批：文档型（document_chunk）与对话型使用不同
        // 的重排判定 prompt，绝不混批。文档批在前仅为确定性；最终决策
        // 按候选 id 回填原序，下游全部按 id 匹配。
        const documentCandidates = semanticCandidates.filter(
          (candidate) => candidate.kind === 'document_chunk',
        );
        const conversationCandidates = semanticCandidates.filter(
          (candidate) => candidate.kind !== 'document_chunk',
        );
        const providerBatches: SemanticCandidate[][] = [];
        for (
          const part of [documentCandidates, conversationCandidates]
        ) {
          for (
            let start = 0;
            start < part.length;
            start += RERANK_PROVIDER_CANDIDATE_LIMIT
          ) {
            providerBatches.push(part.slice(
              start,
              start + RERANK_PROVIDER_CANDIDATE_LIMIT,
            ));
          }
        }
        const reorderDecisions = <T extends { id: string }>(
          operations: { result: T[] }[],
        ): T[] => {
          const decisionById = new Map(
            operations.flatMap((operation) =>
              operation.result.map((decision) =>
                [decision.id, decision] as const
              )
            ),
          );
          return semanticCandidates
            .map((candidate) => decisionById.get(candidate.id))
            .filter((decision): decision is T => Boolean(decision));
        };
        if (ranker.rerankWithTelemetry) {
          const operations = await Promise.all(providerBatches.map(
            (providerBatch) => ranker.rerankWithTelemetry!(
              providerRankingQuery.text,
              providerBatch,
            ),
          ));
          stageDecisions = reorderDecisions(operations);
          rerankTelemetry.push(...operations.map((operation) =>
            operation.telemetry
          ));
        } else {
          const operations = await Promise.all(providerBatches.map(
            async (providerBatch) => {
              const rerankStarted = performance.now();
              const result = await ranker.rerank(
                providerRankingQuery.text,
                providerBatch,
              );
              return {
                result,
                telemetry: legacySemanticOperationTelemetry(
                  'model',
                  retrievalQueryHash(
                    `${ranker.rerankModel}\0rerank\0` +
                    `${providerRankingQuery.text}\0` +
                    providerBatch.map((candidate) => candidate.id).join(','),
                  ),
                  Number((performance.now() - rerankStarted).toFixed(3)),
                  1,
                ),
              };
            },
          ));
          stageDecisions = reorderDecisions(operations);
          rerankTelemetry.push(...operations.map((operation) =>
            operation.telemetry
          ));
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `可靠语义重排不可用，已拒绝降级：${message}`,
          { cause: error },
        );
      }
      decisions.push(...stageDecisions);
      rerankStages.push({
        from: attemptedCandidates,
        to,
        relevant: stageDecisions.filter(
          (decision) =>
            decision.relevant &&
            decision.confidence >= rerankGateFor(decision.id),
        ).length,
      });
      attemptedCandidates = to;
      const qualifiedRelevant = decisions.filter(
        (decision) =>
          decision.relevant &&
          decision.confidence >= rerankGateFor(decision.id),
      );
      relevantCount = qualifiedRelevant.length;
      const relevantCanonicalRows = activeSingleCanonicalRows(
        qualifiedRelevant.map((decision) => decision.id),
      );
      const relevantCanonicalIds = new Set(
        relevantCanonicalRows.map((row) => asString(row.id)),
      );
      relevantCanonicalSelectionIdentityById = new Map(
        relevantCanonicalRows.map((row) => [
          asString(row.id),
          `${asString(row.predicate_key)}\0${
            asString(row.normalized_value_hash)
          }\0${asString(row.scope_type)}\0${asString(row.scope_key)}`,
        ]),
      );
      const relevantCanonicalIdentities = new Set(
        relevantCanonicalRows.map((row) =>
          `${asString(row.predicate_key)}\0${
            asString(row.normalized_value_hash)
          }`),
      );
      effectiveRelevantAnswerCount =
        relevantCanonicalIdentities.size +
        qualifiedRelevant.filter(
          (decision) => !relevantCanonicalIds.has(decision.id),
        ).length;
      const highConfidenceRelevant = qualifiedRelevant.filter(
        (decision) =>
          decision.confidence >= Math.max(
            rerankGateFor(decision.id),
            RERANK_HIGH_CONFIDENCE,
          ),
      );
      const highConfidenceRelevantIds = new Set(
        highConfidenceRelevant.map((decision) => decision.id),
      );
      const canonicalHighConfidenceRows = relevantCanonicalRows.filter(
        (row) => highConfidenceRelevantIds.has(asString(row.id)),
      );
      canonicalRelevantIdentities = new Set(
        canonicalHighConfidenceRows.map((row) =>
          `${asString(row.predicate_key)}\0${
            asString(row.normalized_value_hash)
          }`),
      );
      canonicalRelevantPredicates = new Set(
        canonicalHighConfidenceRows.map((row) =>
          asString(row.predicate_key)),
      );
      canonicalRelevantAnswerCount = canonicalRelevantIdentities.size;
      const attemptedFloor = rerankCandidates[
        attemptedCandidates - 1
      ]?.coarseScore;
      const nextScore = rerankCandidates[
        attemptedCandidates
      ]?.coarseScore;
      coarseScoreCliffRatio =
        highConfidenceRelevant.length > 0 &&
        attemptedFloor !== undefined &&
        attemptedFloor > 0 &&
        nextScore !== undefined
          ? nextScore / attemptedFloor
          : null;
      const unattemptedCanonicalConflict = atomicSingleValueQuery &&
        !activeSingleCanonicalRows(
          rerankCandidates.slice(attemptedCandidates)
            .map((candidate) => candidate.memory.id),
        ).every((row) => {
          const predicate = asString(row.predicate_key);
          const identity = `${predicate}\0${
            asString(row.normalized_value_hash)
          }`;
          return !canonicalRelevantPredicates.has(predicate) ||
            canonicalRelevantIdentities.has(identity);
        });
      coarseScoreCliffStopped =
        !explicitExhaustiveQuery &&
        atomicSingleValueQuery &&
        canonicalRelevantAnswerCount > 0 &&
        canonicalRelevantAnswerCount <= 2 &&
        relevantCount < desiredRelevant &&
        coarseScoreCliffRatio !== null &&
        coarseScoreCliffRatio <= RERANK_COARSE_SCORE_CLIFF_RATIO &&
        !unattemptedCanonicalConflict;
      sufficientRelevantStopped =
        !explicitExhaustiveQuery &&
        effectiveRelevantAnswerCount >= desiredRelevant &&
        !unattemptedCanonicalConflict;
      if (
        sufficientRelevantStopped ||
        coarseScoreCliffStopped ||
        attemptedCandidates >= rerankCandidates.length
      ) break;
    }
    const coarse = rerankCandidates.slice(0, attemptedCandidates);
    const unattemptedCandidates = rerankCandidates.slice(
      attemptedCandidates,
    );
    const rerankStopReason = deterministicExact
      ? 'deterministic_exact_identifier'
      : canonicalDatabaseCandidates.length > 0
        ? 'deterministic_canonical_single_value'
        : canonicalVerificationAbstention
          ? 'deterministic_canonical_value_mismatch'
        : activeAtomicTombstone
          ? 'deterministic_tombstone_abstention'
      : attemptedCandidates >= rerankCandidates.length
        ? 'all_candidates_attempted'
        : sufficientRelevantStopped
          ? 'sufficient_relevant'
          : coarseScoreCliffStopped
            ? 'coarse_score_cliff'
          : 'candidate_cap';
    const earlyStopFilteredCount =
      rerankStopReason === 'sufficient_relevant' ||
      rerankStopReason === 'deterministic_exact_identifier' ||
      rerankStopReason === 'deterministic_canonical_single_value' ||
      rerankStopReason === 'deterministic_canonical_value_mismatch'
      ? unattemptedCandidates.length
      : 0;
    const coarseScoreCliffFilteredCount =
      rerankStopReason === 'coarse_score_cliff'
        ? unattemptedCandidates.length
        : 0;
    const candidateCapFilteredCount = rerankStopReason === 'candidate_cap'
      ? unattemptedCandidates.length
      : 0;
    candidateDecisions.push(
      ...unattemptedCandidates.map(
        (candidate): RetrievalCandidateDecision => ({
          memoryId: candidate.memory.id,
          stage: 'rerank',
          decision: 'not_evaluated',
          evaluated: false,
          reasonCode: rerankStopReason === 'deterministic_exact_identifier'
            ? 'deterministic_exact_identifier_nonmatch'
            : rerankStopReason === 'deterministic_canonical_single_value'
              ? 'deterministic_canonical_single_value_nonmatch'
              : rerankStopReason === 'deterministic_canonical_value_mismatch'
                ? 'deterministic_canonical_value_mismatch'
              : rerankStopReason === 'deterministic_tombstone_abstention'
                ? 'deterministic_tombstone_abstention'
            : rerankStopReason === 'sufficient_relevant'
              ? 'rerank_early_stop_sufficient_relevant'
              : rerankStopReason === 'coarse_score_cliff'
                ? 'rerank_early_stop_coarse_score_cliff'
              : 'rerank_candidate_cap',
          score: rerankStopReason === 'sufficient_relevant' ||
            rerankStopReason === 'deterministic_exact_identifier' ||
            rerankStopReason === 'deterministic_canonical_single_value' ||
            rerankStopReason === 'deterministic_canonical_value_mismatch'
            ? effectiveRelevantAnswerCount
            : rerankStopReason === 'deterministic_tombstone_abstention'
              ? 1
            : rerankStopReason === 'coarse_score_cliff'
              ? Number((coarseScoreCliffRatio || 0).toFixed(6))
            : attemptedCandidates,
          threshold: rerankStopReason === 'deterministic_exact_identifier' ||
            rerankStopReason === 'deterministic_canonical_single_value' ||
            rerankStopReason === 'deterministic_canonical_value_mismatch' ||
            rerankStopReason === 'deterministic_tombstone_abstention'
            ? 1
            : rerankStopReason === 'sufficient_relevant'
            ? desiredRelevant
            : rerankStopReason === 'coarse_score_cliff'
              ? RERANK_COARSE_SCORE_CLIFF_RATIO
            : config.semanticMaxRerankCandidates,
        }),
      ),
    );
    // 重排全拒兜底：当重排把全部候选都判为不相关时（原行为等价于空手而归），
    // 按语义相似度保留前 N 条作为兜底结果。仅影响"重排零命中"的路径；
    // 确定性弃答（墓碑 / 规范值不匹配）不适用，保持其拒答语义。
    // 设 MEMORY_BRIDGE_SEMANTIC_RERANK_EMPTY_FALLBACK_LIMIT=0 可关闭。
    let rerankEmptyFallbackCount = 0;
    if (
      config.semanticRerankEmptyFallbackLimit > 0 &&
      relevantCount === 0 &&
      rerankCandidates.length > 0 &&
      rerankStopReason !== 'deterministic_tombstone_abstention' &&
      rerankStopReason !== 'deterministic_canonical_value_mismatch'
    ) {
      const fallbackLimit = Math.min(
        config.semanticRerankEmptyFallbackLimit,
        resultLimit,
        rerankCandidates.length,
      );
      const fallbackCandidates = [...rerankCandidates]
        .filter((candidate) => {
          // 两类可信来源允许兜底返回，防止不可信内容借兜底路径
          // 把伪造控制行带进答案上下文：
          // ① 一手内容：经认证 API/MCP 直写（origin=api，服务端通道背书，
          //    客户端无法伪造）——知识库直写条目无对话证据链，凭通道放行；
          // ② 二手内容：维持原判据 direct_user / user_confirmed 且有
          //    独立证据摘要（提取管线产物必须挂证据链）。
          if (candidate.memory.origin === 'api') return true;
          const digest = rerankEvidenceDigests.get(candidate.memory.id);
          return Boolean(digest?.versionId) &&
            ['direct_user', 'user_confirmed'].includes(
              candidate.memory.sourceAuthority,
            );
        })
        .sort((left, right) => right.semanticScore - left.semanticScore)
        .slice(0, fallbackLimit);
      const decisionByIdPre = new Map(
        decisions.map((decision) => [decision.id, decision]),
      );
      for (const candidate of fallbackCandidates) {
        const existing = decisionByIdPre.get(candidate.memory.id);
        if (existing) {
          existing.relevant = true;
          existing.confidence = Math.max(
            existing.confidence,
            rerankGateFor(candidate.memory.id),
          );
          existing.reason = '重排全拒，按语义相似度兜底保留';
        } else {
          decisions.push({
            id: candidate.memory.id,
            relevant: true,
            confidence: rerankGateFor(candidate.memory.id),
            reason: '重排全拒，按语义相似度兜底保留',
          });
        }
      }
      rerankEmptyFallbackCount = fallbackCandidates.length;
    }
    // 重排相关不足填充：relevant 数量不足 min(fillerLimit, resultLimit) 时，
    // 按粗排语义分保留最高分的 non-relevant 候选（标 filler、排序垫底），
    // 避免多跳证据链的中间环节（含线索但不含答案）被二值过滤物理删除。
    // 与"全拒兜底"互补：relevantCount===0 时走上面的兜底路径，不重复触发。
    // 确定性弃答（墓碑 / 规范值不匹配）不适用，保持其拒答语义。
    // 默认 semanticRerankFillerLimit=0 = 现行为，零回归。
    let rerankFillerCount = 0;
    const fillerDecisionIds = new Set<string>();
    if (
      config.semanticRerankFillerLimit > 0 &&
      relevantCount > 0 &&
      rerankCandidates.length > 0 &&
      rerankStopReason !== 'deterministic_tombstone_abstention' &&
      rerankStopReason !== 'deterministic_canonical_value_mismatch'
    ) {
      const fillerTarget = Math.min(
        config.semanticRerankFillerLimit,
        resultLimit,
      );
      const fillerNeed = fillerTarget - relevantCount;
      if (fillerNeed > 0) {
        const decisionByIdFiller = new Map(
          decisions.map((decision) => [decision.id, decision]),
        );
        const fillerCandidates = rerankCandidates
          .slice(0, attemptedCandidates)
          .filter((candidate) => {
            const existing = decisionByIdFiller.get(candidate.memory.id);
            if (existing?.relevant) return false;
            // 与"全拒兜底"相同的可信来源过滤：
            // ① 一手内容 origin=api（认证通道直写，知识库条目凭通道放行）；
            // ② 二手内容维持 direct_user / user_confirmed 且有独立证据摘要。
            if (candidate.memory.origin === 'api') return true;
            const digest = rerankEvidenceDigests.get(candidate.memory.id);
            return Boolean(digest?.versionId) &&
              ['direct_user', 'user_confirmed'].includes(
                candidate.memory.sourceAuthority,
              );
          })
          .sort((left, right) => right.semanticScore - left.semanticScore)
          .slice(0, fillerNeed);
        for (const candidate of fillerCandidates) {
          const existing = decisionByIdFiller.get(candidate.memory.id);
          const fillerReason = '重排未判相关，按粗排分填充（垫底）';
          if (existing) {
            existing.relevant = true;
            existing.confidence = rerankGateFor(candidate.memory.id);
            existing.reason = fillerReason;
          } else {
            decisions.push({
              id: candidate.memory.id,
              relevant: true,
              confidence: rerankGateFor(candidate.memory.id),
              reason: fillerReason,
            });
          }
          fillerDecisionIds.add(candidate.memory.id);
        }
        rerankFillerCount = fillerDecisionIds.size;
      }
    }
    const rerankAttemptTelemetry = rerankTelemetry.map(
      semanticOperationTraceTelemetry,
    );
    const rerankRoute = rerankTelemetry.some(
      (telemetry) => telemetry.route === 'model',
    )
      ? 'model'
      : rerankTelemetry.some((telemetry) => telemetry.route === 'cache')
        ? 'cache'
        : 'deterministic_fast';
    const rerankProviderDurationMs = rerankTelemetry.reduce(
      (total, telemetry) => total + (telemetry.providerDurationMs || 0),
      0,
    );
    trace.event('rerank', {
      model: ranker.rerankModel,
      route: rerankRoute,
      providerCalls: rerankTelemetry.reduce(
        (total, telemetry) => total + telemetry.providerCalls,
        0,
      ),
      cacheHit: rerankTelemetry.some((telemetry) => telemetry.cacheHit),
      singleFlightShared: rerankTelemetry.some(
        (telemetry) => telemetry.singleFlightShared,
      ),
      keyFingerprint: rerankTelemetry.length === 1
        ? rerankTelemetry[0].keyFingerprint
        : null,
      requestDurationMs: Number(rerankTelemetry.reduce(
        (total, telemetry) => total + telemetry.requestDurationMs,
        0,
      ).toFixed(3)),
      providerDurationMs: rerankProviderDurationMs > 0
        ? Number(rerankProviderDurationMs.toFixed(3))
        : null,
      modelTelemetry: rerankTelemetry.length === 1
        ? rerankTelemetry[0].model
        : null,
      attempts: rerankAttemptTelemetry,
      stageRerankCalls: rerankStages.length,
      physicalProviderRerankCalls: ranker.rerankWithTelemetry
        ? rerankTelemetry.reduce(
            (total, telemetry) => total + telemetry.providerCalls,
            0,
          )
        : null,
      baseProviderRerankCalls: ranker.rerankWithTelemetry
        ? rerankTelemetry.reduce(
            (total, telemetry) =>
              total + (telemetry.baseProviderCalls || 0),
            0,
          )
        : null,
      firstCandidateConfirmationCalls: ranker.rerankWithTelemetry
        ? rerankTelemetry.reduce(
            (total, telemetry) =>
              total + (telemetry.firstCandidateConfirmationCalls || 0),
            0,
          )
        : null,
      protocolRecoveryCalls: ranker.rerankWithTelemetry
        ? rerankTelemetry.reduce(
            (total, telemetry) =>
              total + (telemetry.protocolRecoveryCalls || 0),
            0,
          )
        : null,
      protocolRecoveryMaxDepth: ranker.rerankWithTelemetry
        ? rerankTelemetry.reduce(
            (maximum, telemetry) => Math.max(
              maximum,
              telemetry.protocolRecoveryMaxDepth || 0,
            ),
            0,
          )
        : null,
      parallelBatchCount: ranker.rerankWithTelemetry
        ? rerankTelemetry.reduce(
            (maximum, telemetry) => Math.max(
              maximum,
              telemetry.parallelBatchCount || 0,
            ),
            0,
          )
        : null,
      providerQueueWaitMs: ranker.rerankWithTelemetry
        ? Number(rerankTelemetry.reduce(
            (total, telemetry) =>
              total + (telemetry.providerQueueWaitMs || 0),
            0,
          ).toFixed(3))
        : null,
      providerPeakActive: ranker.rerankWithTelemetry
        ? rerankTelemetry.reduce(
            (maximum, telemetry) => Math.max(
              maximum,
              telemetry.providerPeakActive || 0,
            ),
            0,
          )
        : null,
      providerMaxConcurrency: ranker.rerankWithTelemetry
        ? rerankTelemetry.reduce(
            (maximum, telemetry) => Math.max(
              maximum,
              telemetry.providerMaxConcurrency || 0,
            ),
            0,
          )
        : null,
      telemetryUnavailableReason: ranker.rerankWithTelemetry
        ? null
        : 'legacy_ranker_without_operation_telemetry',
      providerQueryOriginalCharacters:
        providerRankingQuery.originalCharacters,
      providerQueryCharacters: providerRankingQuery.providerCharacters,
      providerQueryBudget: RERANK_PROVIDER_QUERY_TEXT_BUDGET,
      providerQueryTruncated: providerRankingQuery.truncated,
      providerCandidateLimit: RERANK_PROVIDER_CANDIDATE_LIMIT,
      providerCandidateTextBudget: config.semanticRerankCandidateTextBudget,
      atomicSingleValueQuery,
      desiredRelevant,
      relevantCandidateCount: relevantCount,
      effectiveRelevantAnswerCount,
      canonicalRelevantAnswerCount,
      canonicalAnswerGroupCount: canonicalRelevantAnswerCount,
      evidenceDigests: rerankCandidates
        .slice(0, attemptedCandidates)
        .map((candidate) => {
          const digest = rerankEvidenceDigests.get(candidate.memory.id);
          return {
            memoryId: candidate.memory.id,
            versionId: digest?.versionId || null,
            proofCount: digest?.proofCount || 0,
            firstEvidenceAt: digest?.firstEvidenceAt || null,
            lastEvidenceAt: digest?.lastEvidenceAt || null,
          };
        }),
      minConfidence: config.semanticMinConfidence,
      stages: rerankStages,
      attemptedCandidates,
      stopReason: rerankStopReason,
      coarseScoreCliffRatio: coarseScoreCliffRatio === null
        ? null
        : Number(coarseScoreCliffRatio.toFixed(6)),
      coarseScoreCliffThreshold: RERANK_COARSE_SCORE_CLIFF_RATIO,
      earlyStopFilteredCount,
      coarseScoreCliffFilteredCount,
      candidateCapFilteredCount,
      decisions: decisions.map((decision) => ({
        memoryId: decision.id,
        relevant: decision.relevant,
        confidence: decision.confidence,
        reason: decision.reason,
      })),
      rerankEmptyFallbackCount: rerankEmptyFallbackCount,
      rerankFillerCount: rerankFillerCount,
    });
    const decisionById = new Map(
      decisions.map((decision) => [decision.id, decision]),
    );
    const feedbackPriors = this.feedbackPriors(
      coarse.map((candidate) => candidate.memory.id),
    );
    const minScore = Math.max(
      0.12,
      Math.min(1, input.minScore ?? 0.18),
    );
    let rerankFilteredCount = 0;
    let scoreFilteredCount = 0;
    const rankedResults = coarse
      .map(({
        memory,
        retrieval,
        semanticScore,
        channelScore,
        temporalSignal,
      }): RecallResult | null => {
        const decision = decisionById.get(memory.id);
        if (
          !decision?.relevant ||
          decision.confidence < rerankGateFor(memory.id)
        ) {
          rerankFilteredCount += 1;
          candidateDecisions.push({
            memoryId: memory.id,
            stage: 'rerank',
            decision: 'rejected',
            evaluated: true,
            reasonCode: !decision?.relevant
              ? 'rerank_rejected'
              : 'rerank_confidence_below_threshold',
            score: Number((decision?.confidence || 0).toFixed(6)),
            threshold: config.semanticMinConfidence,
          });
          return null;
        }
        const relevance =
          semanticScore * (1 - config.semanticRerankConfidenceWeight) +
          decision.confidence * config.semanticRerankConfidenceWeight;
        if (relevance < minScore) {
          scoreFilteredCount += 1;
          candidateDecisions.push({
            memoryId: memory.id,
            stage: 'selection',
            decision: 'rejected',
            evaluated: true,
            reasonCode: 'combined_score_below_threshold',
            score: Number(relevance.toFixed(6)),
            threshold: minScore,
          });
          return null;
        }
        const recency = recencyScore(memory.updatedAt);
        const feedbackPrior = feedbackPriors.get(memory.id) || 0;
        const baseScore =
          relevance * 0.83 +
          channelScore * 0.05 +
          memory.importance * 0.05 +
          memory.confidence * 0.04 +
          recency * 0.03;
        const score = Math.max(0, Math.min(1,
          (temporalPlan
            ? baseScore * 0.85 + (temporalSignal?.score || 0) * 0.15
            : baseScore) +
          feedbackPrior,
        ));
        const reasons: string[] = [
          `本地语义相似 ${(semanticScore * 100).toFixed(0)}%`,
          rerankRoute === 'deterministic_fast'
            ? `确定性标识匹配：${decision.reason}`
            : decision.reason
              ? `严格重排：${decision.reason}`
              : '严格重排确认可直接回答',
        ];
        if (fillerDecisionIds.has(memory.id)) {
          reasons.push('重排相关不足：按粗排分填充（排序垫底）');
        }
        if (retrieval.lexicalRank) {
          reasons.push(`FTS5/BM25 第 ${retrieval.lexicalRank} 名`);
        }
        if (retrieval.annRank) {
          reasons.push(
            `Dense sign-LSH 近邻第 ${retrieval.annRank} 名`,
          );
        }
        if (retrieval.termRank) {
          reasons.push(
            `实体/概念倒排第 ${retrieval.termRank} 名`,
          );
        }
        if (retrieval.graphRank) {
          reasons.push(`关系图一跳扩散第 ${retrieval.graphRank} 名`);
        }
        if (feedbackPrior !== 0) {
          reasons.push(
            `有界反馈先验 ${feedbackPrior > 0 ? '+' : ''}` +
              feedbackPrior.toFixed(3),
          );
        }
        if (temporalPlan && temporalSignal) {
          reasons.push(temporalReason(temporalPlan, temporalSignal));
        }
        const evidenceDigest = rerankEvidenceDigests.get(memory.id);
        if (evidenceDigest) {
          reasons.push(
            `当前版本独立用户证据 ${evidenceDigest.proofCount} 条`,
          );
        }
        return {
          memory,
          score: Number(score.toFixed(4)),
          reasons,
          explanation: {
            lexicalRank: retrieval.lexicalRank,
            annRank: retrieval.annRank,
            termRank: retrieval.termRank,
            graphRank: retrieval.graphRank,
            semanticSimilarity: Number(
              semanticScore.toFixed(4),
            ),
            rerankConfidence: Number(
              decision.confidence.toFixed(4),
            ),
            feedbackPrior: Number(feedbackPrior.toFixed(4)),
            importance: Number(memory.importance.toFixed(4)),
            memoryConfidence: Number(
              memory.confidence.toFixed(4),
            ),
            recency: Number(recency.toFixed(4)),
            status: memory.status,
            conflictState: conflictState(memory.status),
            diversityPenalty: 0,
          },
        };
      })
      .filter((result): result is RecallResult => result !== null)
      .sort((left, right) => right.score - left.score);
    // filler 垫底：填充条目排在本轮 relevant 结果之后（组内保持分序），
    // 保证"relevant 优先"语义不被填充破坏。
    const orderedResults = fillerDecisionIds.size > 0
      ? [
          ...rankedResults.filter(
            (result) => !fillerDecisionIds.has(result.memory.id),
          ),
          ...rankedResults.filter((result) =>
            fillerDecisionIds.has(result.memory.id),
          ),
        ]
      : rankedResults;
    const seenCanonicalSelectionIdentities = new Set<string>();
    const duplicateCanonicalProjectionIds = new Set<string>();
    const canonicalDeduplicatedResults = orderedResults.filter((result) => {
      const identity = relevantCanonicalSelectionIdentityById.get(
        result.memory.id,
      );
      if (!identity) return true;
      if (seenCanonicalSelectionIdentities.has(identity)) {
        duplicateCanonicalProjectionIds.add(result.memory.id);
        return false;
      }
      seenCanonicalSelectionIdentities.add(identity);
      return true;
    });
    candidateDecisions.push(
      ...rankedResults
        .filter((result) =>
          duplicateCanonicalProjectionIds.has(result.memory.id))
        .map((result): RetrievalCandidateDecision => ({
          memoryId: result.memory.id,
          stage: 'selection',
          decision: 'rejected',
          evaluated: true,
          reasonCode: 'canonical_duplicate_projection',
        })),
    );
    const consolidated = this.collapseCoveredAtomicResults(
      canonicalDeduplicatedResults,
    );
    const consolidatedIds = new Set(
      consolidated.results.map((result) => result.memory.id),
    );
    candidateDecisions.push(
      ...canonicalDeduplicatedResults
        .filter((result) => !consolidatedIds.has(result.memory.id))
        .map((result): RetrievalCandidateDecision => ({
          memoryId: result.memory.id,
          stage: 'selection',
          decision: 'rejected',
          evaluated: true,
          reasonCode: 'derived_summary_coverage',
        })),
    );
    const scopeFiltered = this.applyScopePrecedence(
      consolidated.results,
    );
    const scopeFilteredIds = new Set(
      scopeFiltered.results.map((result) => result.memory.id),
    );
    candidateDecisions.push(
      ...consolidated.results
        .filter((result) => !scopeFilteredIds.has(result.memory.id))
        .map((result): RetrievalCandidateDecision => ({
          memoryId: result.memory.id,
          stage: 'selection',
          decision: 'rejected',
          evaluated: true,
          reasonCode: 'scope_precedence',
        })),
    );
    const results = orderTemporalResults(
      temporalPlan,
      selectLayeredRecallResults(
        selectDiverseResults(
          scopeFiltered.results,
          scopeFiltered.results.length,
        ),
        resultLimit,
      ),
    );
    const selectedIds = new Set(
      results.map((result) => result.memory.id),
    );
    candidateDecisions.push(
      ...scopeFiltered.results
        .filter((result) => !selectedIds.has(result.memory.id))
        .map((result): RetrievalCandidateDecision => ({
          memoryId: result.memory.id,
          stage: 'selection',
          decision: 'rejected',
          evaluated: true,
          reasonCode: 'result_limit_or_diversity',
        })),
    );
    const filterSummary = [
      {
        reasonCode: 'semantic_below_threshold',
        reason: '语义相似度低于门槛',
        count: similarityFilteredCount,
      },
      {
        reasonCode: 'rerank_candidate_cap',
        reason: '超过重排候选上限',
        count: candidateCapFilteredCount,
      },
      {
        reasonCode: 'rerank_early_stop_sufficient_relevant',
        reason: '已有足够相关结果，停止扩大重排',
        count: earlyStopFilteredCount,
      },
      {
        reasonCode: 'rerank_early_stop_coarse_score_cliff',
        reason: '已有高置信结果且后续粗排候选明显变差',
        count: coarseScoreCliffFilteredCount,
      },
      {
        reasonCode: 'rerank_rejected_or_low_confidence',
        reason: '严格重排判定无关或置信不足',
        count: rerankFilteredCount,
      },
      {
        reasonCode: 'combined_score_below_threshold',
        reason: '综合相关性低于门槛',
        count: scoreFilteredCount,
      },
      {
        reasonCode: 'canonical_duplicate_projection',
        reason: '同一规范事实的重复投影',
        count: duplicateCanonicalProjectionIds.size,
      },
      {
        reasonCode: 'derived_summary_coverage',
        reason: '被有效派生摘要覆盖',
        count: consolidated.suppressedCount,
      },
      {
        reasonCode: 'scope_precedence',
        reason: '被更高优先级作用域遮蔽',
        count: scopeFiltered.suppressedCount,
      },
      {
        reasonCode: 'result_limit_or_diversity',
        reason: '超过结果数量上限',
        count: Math.max(
          scopeFiltered.results.length - results.length,
          0,
        ),
      },
    ].filter((item) => item.count > 0);

    const updateAccess = this.database.prepare(
      `UPDATE memories
       SET access_count = access_count + 1, last_accessed_at = ?
       WHERE id = ? AND user_id = ?`,
    );
    const updateRetrieved = this.database.prepare(
      `UPDATE memory_items
       SET retrieved_count = retrieved_count + 1
       WHERE id = ? AND user_id = ?`,
    );
    const watermark = this.retrievalIndex.denseWatermark({
      userId: ownerId,
      namespace: targetNamespace,
      generationId: generation.generationId,
      embeddingModel: generation.embeddingModel,
      timestamp,
      dimensions: queryVector.length,
      generationKey,
      includeArchived: input.includeArchived,
      scopes,
      allowedSensitivities:
        input.allowedSensitivities || ['normal'],
      verifyLshBands: false,
    });
    observeQuality?.(
      watermark.complete ? 'full' : 'degraded',
    );
    this.database.exec('BEGIN');
    try {
      for (const result of results) {
        updateAccess.run(timestamp, result.memory.id, ownerId);
        updateRetrieved.run(result.memory.id, ownerId);
        result.memory.accessCount += 1;
        result.memory.lastAccessedAt = timestamp;
      }
      this.audit('recall', null, ownerId, {
        traceId: trace.traceId,
        queryHash: retrievalQueryHash(query),
        query: config.retrievalLogMode === 'diagnostic'
          ? query
          : undefined,
        mode: 'hybrid-semantic',
        qualityState: watermark.complete ? 'full' : 'degraded',
        temporalIntent: temporalPlan
          ? {
              kind: temporalPlan.kind,
              label: temporalPlan.label,
              rangeStartAt: temporalPlan.rangeStartMs === null
                ? null
                : new Date(temporalPlan.rangeStartMs).toISOString(),
              rangeEndAt: temporalPlan.rangeEndMs === null
                ? null
                : new Date(temporalPlan.rangeEndMs).toISOString(),
            }
          : null,
        embeddingModel: generation.embeddingModel,
        rerankModel: ranker.rerankModel,
        denseEligible: watermark.eligible,
        denseIndexed: watermark.indexed,
        indexVersion: DENSE_LSH_VERSION,
        generationId: generation.generationId,
        generationKey,
        candidateCount: candidates.length,
        rerankCandidateCount: coarse.length,
        lexicalCandidateCount: candidates.filter(
          ({ retrieval }) => retrieval.lexicalRank !== null,
        ).length,
        annCandidateCount: candidates.filter(
          ({ retrieval }) => retrieval.annRank !== null,
        ).length,
        termCandidateCount: candidates.filter(
          ({ retrieval }) => retrieval.termRank !== null,
        ).length,
        graphCandidateCount: candidates.filter(
          ({ retrieval }) => retrieval.graphRank !== null,
        ).length,
        filterSummary,
        candidateDecisions,
        resultIds: results.map((result) => result.memory.id),
        resultDetails: this.recallResultDetails(results, ownerId),
      });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    trace.event('selection', {
      scopeSuppressedCount: scopeFiltered.suppressedCount,
      consolidationSuppressedCount: consolidated.suppressedCount,
      filterSummary,
      candidateDecisions,
      resultIds: results.map((result) => result.memory.id),
      results: this.recallResultDetails(results, ownerId),
    });
    return results.map((result) => ({
      ...result,
      traceId: trace.traceId,
    }));
  }

  getContext(input: RecallInput): {
    query: string;
    memories: RecallResult[];
    context: string;
    qualityState: 'degraded';
  } {
    const memories = this.recall(input);
    const context = this.buildMemoryContext(
      memories,
      cleanUserId(input.userId),
      input.contextTokenBudget,
    );
    return {
      query: input.query,
      memories,
      context,
      qualityState: 'degraded',
    };
  }

  async getContextReliable(
    input: RecallInput,
    options: ReliableRecallOptions = {},
  ): Promise<{
    traceId: string;
    query: string;
    memories: RecallResult[];
    context: string;
    qualityState: 'full' | 'degraded' | 'unavailable';
    queryUnderstanding?: QueryUnderstandingResult;
    grounding: Array<{
      memoryId: string;
      versionId: string | null;
      evidence: Array<{
        evidenceType: string;
        turnId: string | null;
        sourceRef: string | null;
      }>;
      proofCount: number;
      firstEvidenceAt: string | null;
      lastEvidenceAt: string | null;
      excerpts: string[];
    }>;
  }> {
    // 入口先校验 as-of：无效时间戳必须 fail-loud，不能落进降级 catch 被吞。
    if (input.timestamp) cleanDate(input.timestamp, 'timestamp');
    const releaseForeground = options.qosClass === 'background'
      ? () => {}
      : beginForegroundActivity();
    try {
    const trace = this.createRetrievalTrace(input, options.traceContext);
    options.onTraceCreated?.(trace.traceId);
    const ownerId = cleanUserId(input.userId);
    const targetNamespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    let memories: RecallResult[];
    let recallQualityState: 'full' | 'degraded' = 'degraded';
    try {
      memories = await this.recallReliableInternal(
        input,
        (qualityState) => {
          recallQualityState = qualityState;
        },
        trace,
        options,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const semanticFailure = semanticOperationFailure(error);
      const failedAlias = this.retrievalIndex.denseAlias(
        ownerId,
        targetNamespace,
      );
      const failedGeneration = failedAlias?.activeGenerationId
        ? this.retrievalIndex.denseGenerationById(
            failedAlias.activeGenerationId,
          )
        : null;
      this.audit('recall', null, ownerId, {
        traceId: trace.traceId,
        queryHash: retrievalQueryHash(cleanText(input.query)),
        query: config.retrievalLogMode === 'diagnostic'
          ? cleanText(input.query)
          : undefined,
        mode: 'hybrid-semantic',
        qualityState: 'unavailable',
        embeddingModel:
          failedGeneration?.embeddingModel ??
          this.semanticRanker?.embeddingModel,
        rerankModel: this.semanticRanker?.rerankModel,
        generationId: failedGeneration?.generationId,
        generationKey: failedGeneration?.generationKey,
        error: message,
        filterSummary: [{
          reasonCode: 'semantic_pipeline_unavailable',
          reason: '语义流水线不可用',
          count: 1,
        }],
        resultIds: [],
        resultDetails: [],
      });
      trace.completeFailedStages(
        'semantic_pipeline_unavailable',
        message,
        {
          injectedMemoryIds: [],
          tokenBudget: input.contextTokenBudget ||
            config.memoryContextTokenBudget,
          actualTokens: 0,
          groundingState: 'unavailable',
        },
        semanticFailure
          ? {
            operation: semanticFailure.operation,
            failureCode: semanticFailure.code,
            ...semanticOperationTraceTelemetry(
              semanticFailure.telemetry,
            ),
          }
          : {},
      );
      trace.finish({
        qualityState: 'unavailable',
        resultCount: 0,
        errorCode: 'semantic_pipeline_unavailable',
        detail: { error: message },
      });
      return {
        traceId: trace.traceId,
        query: input.query,
        memories: [],
        context: '长期记忆语义服务当前不可用，本轮未注入记忆。',
        qualityState: 'unavailable',
        queryUnderstanding: options.queryUnderstanding,
        grounding: [],
      };
    }
    if (
      memories.length === 0 &&
      !options.qualityFallbackAttempted &&
      options.qualityFallback &&
      (!options.queryUnderstanding ||
        options.queryUnderstanding.status === 'not_needed')
    ) {
      let fallbackUnderstanding: QueryUnderstandingResult | null = null;
      trace.beginAttempt('quality_fallback');
      try {
        fallbackUnderstanding = await options.qualityFallback();
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        recallQualityState = 'degraded';
        trace.completeFailedStages(
          'quality_fallback_unavailable',
          message,
          {
            tokenBudget: input.contextTokenBudget ||
              config.memoryContextTokenBudget,
            actualTokens: 0,
            groundingState: 'degraded',
            injectedMemoryIds: [],
          },
        );
        trace.finish({
          qualityState: recallQualityState,
          resultCount: memories.length,
          errorCode: 'quality_fallback_unavailable',
          detail: {
            error: message,
            resultIds: memories.map((result) => result.memory.id),
          },
        });
        return {
          traceId: trace.traceId,
          query: input.query,
          memories,
          context:
            '本轮没有找到足够相关的长期记忆，查询补救服务当前不可用。',
          qualityState: recallQualityState,
          queryUnderstanding: options.queryUnderstanding,
          grounding: [],
        };
      }
      const fallbackUseful = hasQualityFallbackQueryDelta(
        input.query,
        fallbackUnderstanding,
      );
      if (fallbackUseful && fallbackUnderstanding) {
        try {
          memories = await this.recallReliableInternal(
            input,
            (qualityState) => {
              recallQualityState = qualityState;
            },
            trace,
            {
              ...options,
              queryUnderstanding: fallbackUnderstanding,
              qualityFallbackAttempted: true,
            },
          );
          options = {
            ...options,
            queryUnderstanding: fallbackUnderstanding,
            qualityFallbackAttempted: true,
          };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          trace.completeFailedStages(
            'semantic_pipeline_unavailable',
            message,
            {
              tokenBudget: input.contextTokenBudget ||
                config.memoryContextTokenBudget,
              actualTokens: 0,
              groundingState: 'unavailable',
              injectedMemoryIds: [],
            },
          );
          trace.finish({
            qualityState: 'unavailable',
            resultCount: 0,
            errorCode: 'semantic_pipeline_unavailable',
            detail: { error: message },
          });
          return {
            traceId: trace.traceId,
            query: input.query,
            memories: [],
            context: '长期记忆语义服务当前不可用，本轮未注入记忆。',
            qualityState: 'unavailable',
            queryUnderstanding: fallbackUnderstanding,
            grounding: [],
          };
        }
      } else {
        trace.event('rewrite', {
          mode: 'contextual',
          triggered: true,
          ...queryUnderstandingTraceTelemetry(fallbackUnderstanding),
          qualityFallbackOutcome: 'not_useful',
          understandingStatus: fallbackUnderstanding?.status || 'empty',
          skipped: true,
          reason: fallbackUnderstanding?.status === 'resolved'
            ? 'quality_fallback_no_query_delta'
            : 'quality_fallback_not_useful',
        });
      }
    }
    const selectedEvidenceDigests = this.memoryEvidenceDigests(
      memories.map((result) => result.memory.id),
      ownerId,
    );
    const context = this.buildMemoryContext(
      memories,
      ownerId,
      input.contextTokenBudget,
      selectedEvidenceDigests,
    );
    const grounding = this.memoryGroundingSources(
      memories,
      ownerId,
      selectedEvidenceDigests,
    );
    trace.event('context', {
      tokenBudget: input.contextTokenBudget ||
        config.memoryContextTokenBudget,
      actualTokens: approximateTokenCount(context),
      groundingState: memories.length > 0
        ? 'grounded'
        : 'no_relevant_memory',
      injectedMemoryIds: memories.map((result) => result.memory.id),
      injectedSources: grounding,
    });
    trace.finish({
      qualityState: recallQualityState,
      resultCount: memories.length,
      detail: {
        resultIds: memories.map((result) => result.memory.id),
      },
    });
    return {
      traceId: trace.traceId,
      query: input.query,
      memories,
      context,
      qualityState: recallQualityState,
      queryUnderstanding: options.queryUnderstanding,
      grounding,
    };
    } finally {
      releaseForeground();
    }
  }

  private memoryEvidenceDigests(
    memoryIds: readonly string[],
    ownerId: string,
  ): Map<string, MemoryEvidenceDigest> {
    const ids = [...new Set(memoryIds.map((id) => cleanText(id)).filter(
      Boolean,
    ))];
    if (ids.length === 0) return new Map();
    ensureEvidenceDigestSqlFunctions(this.database);
    const placeholders = ids.map(() => '?').join(', ');
    const summaryRows = this.database.prepare(
      `/* memory_evidence_digest_summary */
       SELECT i.id AS memory_id,
              i.current_version_id AS version_id,
              COUNT(DISTINCT CASE
                WHEN t.role = 'user'
                 AND t.user_id = i.user_id
                 AND t.namespace = i.namespace
                 AND e.source_authority IN (
                   'direct_user', 'user_confirmed'
                 )
                THEN e.turn_id
              END) AS proof_count,
              MIN(CASE
                WHEN t.role = 'user'
                 AND t.user_id = i.user_id
                 AND t.namespace = i.namespace
                 AND e.source_authority IN (
                   'direct_user', 'user_confirmed'
                 )
                THEN COALESCE(
                  NULLIF(t.occurred_at, ''),
                  NULLIF(e.created_at, '')
                )
              END) AS first_evidence_at,
              MAX(CASE
                WHEN t.role = 'user'
                 AND t.user_id = i.user_id
                 AND t.namespace = i.namespace
                 AND e.source_authority IN (
                   'direct_user', 'user_confirmed'
                 )
                THEN COALESCE(
                  NULLIF(t.occurred_at, ''),
                  NULLIF(e.created_at, '')
                )
              END) AS last_evidence_at
       FROM memory_items i
       JOIN memories m
         ON m.id = i.id
        AND m.user_id = i.user_id
        AND m.namespace = i.namespace
       JOIN memory_versions v
         ON v.id = i.current_version_id
        AND v.memory_item_id = i.id
        AND v.superseded_at IS NULL
       LEFT JOIN memory_evidence e
         ON e.memory_version_id = i.current_version_id
       LEFT JOIN conversation_turns t
         ON t.id = e.turn_id
       WHERE i.user_id = ?
         AND i.status = 'active'
         AND m.status = 'active'
         AND i.id IN (${placeholders})
       GROUP BY i.id, i.current_version_id
       ORDER BY i.id ASC`,
    ).all(ownerId, ...ids) as DatabaseRow[];
    const digests = new Map<string, MemoryEvidenceDigest>();
    for (const row of summaryRows) {
      const memoryId = asString(row.memory_id);
      if (!memoryId) continue;
      digests.set(memoryId, {
        versionId: asNullableString(row.version_id),
        proofCount: Math.max(0, Number(row.proof_count) || 0),
        firstEvidenceAt: asNullableString(row.first_evidence_at),
        lastEvidenceAt: asNullableString(row.last_evidence_at),
        excerpts: [],
        evidence: [],
      });
    }

    const metadataRows = this.database.prepare(
      `/* memory_evidence_digest_metadata */
       WITH eligible_memories AS (
         SELECT i.id AS memory_id,
                i.current_version_id AS version_id
         FROM memory_items i
         JOIN memories m
           ON m.id = i.id
          AND m.user_id = i.user_id
          AND m.namespace = i.namespace
         JOIN memory_versions v
           ON v.id = i.current_version_id
          AND v.memory_item_id = i.id
          AND v.superseded_at IS NULL
         WHERE i.user_id = ?
           AND i.status = 'active'
           AND m.status = 'active'
           AND i.id IN (${placeholders})
       )
       SELECT b.memory_id,
              e.evidence_type,
              e.turn_id,
              e.source_ref
       FROM eligible_memories b
       JOIN memory_evidence e
         ON e.id IN (
           SELECT limited.id
           FROM memory_evidence limited
           WHERE limited.memory_version_id = b.version_id
           ORDER BY limited.created_at ASC, limited.id ASC
           LIMIT 10
         )
       ORDER BY b.memory_id ASC, e.created_at ASC, e.id ASC`,
    ).all(ownerId, ...ids) as DatabaseRow[];
    for (const row of metadataRows) {
      const digest = digests.get(asString(row.memory_id));
      if (!digest) continue;
      digest.evidence.push({
        evidenceType: asString(row.evidence_type),
        turnId: asNullableString(row.turn_id),
        sourceRef: asNullableString(row.source_ref),
      });
    }

    const excerptRows = this.database.prepare(
      `/* memory_evidence_digest_excerpts */
       WITH eligible_memories AS (
         SELECT i.id AS memory_id,
                i.current_version_id AS version_id,
                i.user_id AS memory_user_id,
                i.namespace AS memory_namespace,
                m.sensitivity AS memory_sensitivity
         FROM memory_items i
         JOIN memories m
           ON m.id = i.id
          AND m.user_id = i.user_id
          AND m.namespace = i.namespace
         JOIN memory_versions v
           ON v.id = i.current_version_id
          AND v.memory_item_id = i.id
          AND v.superseded_at IS NULL
         WHERE i.user_id = ?
           AND i.status = 'active'
           AND m.status = 'active'
           AND i.id IN (${placeholders})
       ),
       trimmed_excerpts AS (
         SELECT b.memory_id,
                memory_bridge_trim_evidence_excerpt_v1(
                  e.excerpt
                ) AS raw_excerpt,
                COALESCE(
                  NULLIF(t.occurred_at, ''),
                  NULLIF(e.created_at, ''),
                  ''
                ) AS occurred_at,
                e.created_at AS evidence_created_at,
                e.id AS evidence_id,
                t.content AS turn_content
         FROM eligible_memories b
         JOIN memory_evidence e
           ON e.memory_version_id = b.version_id
         JOIN conversation_turns t
           ON t.id = e.turn_id
         WHERE b.memory_sensitivity = 'normal'
           AND e.sensitivity = 'normal'
           AND e.source_authority IN (
             'direct_user', 'user_confirmed'
           )
           AND t.role = 'user'
           AND t.user_id = b.memory_user_id
           AND t.namespace = b.memory_namespace
           AND e.excerpt IS NOT NULL
       ),
       legal_excerpts AS (
         SELECT memory_id,
                memory_bridge_bounded_evidence_excerpt_v1(
                  raw_excerpt
                ) AS excerpt,
                occurred_at,
                evidence_created_at,
                evidence_id
         FROM trimmed_excerpts
         WHERE raw_excerpt <> ''
           AND INSTR(turn_content, raw_excerpt) > 0
           AND memory_bridge_evidence_excerpt_is_safe_v1(
             raw_excerpt
           ) = 1
       ),
       deduplicated_excerpts AS (
         SELECT memory_id,
                excerpt,
                occurred_at,
                evidence_created_at,
                evidence_id,
                ROW_NUMBER() OVER (
                  PARTITION BY memory_id, excerpt
                  ORDER BY occurred_at DESC,
                           evidence_created_at ASC,
                           evidence_id ASC
                ) AS duplicate_rank
         FROM legal_excerpts
       ),
       ranked_excerpts AS (
         SELECT memory_id,
                excerpt,
                ROW_NUMBER() OVER (
                  PARTITION BY memory_id
                  ORDER BY occurred_at DESC,
                           evidence_created_at ASC,
                           evidence_id ASC
                ) AS excerpt_rank
         FROM deduplicated_excerpts
         WHERE duplicate_rank = 1
       )
       SELECT memory_id, excerpt
       FROM ranked_excerpts
       WHERE excerpt_rank <= 2
       ORDER BY memory_id ASC, excerpt_rank ASC`,
    ).all(ownerId, ...ids) as DatabaseRow[];
    for (const row of excerptRows) {
      const digest = digests.get(asString(row.memory_id));
      const excerpt = asString(row.excerpt);
      if (digest && excerpt) digest.excerpts.push(excerpt);
    }
    return digests;
  }

  private buildMemoryContext(
    memories: RecallResult[],
    ownerId: string,
    requestedBudget?: number,
    evidenceDigests?: Map<string, MemoryEvidenceDigest>,
  ): string {
    if (memories.length === 0) {
      return '本轮没有找到足够相关的长期记忆；这不代表用户从未表达过相关信息。';
    }
    const budget = Math.max(
      256,
      Math.min(
        Math.trunc(
          requestedBudget || config.memoryContextTokenBudget,
        ),
        8192,
      ),
    );
    const digests = evidenceDigests || this.memoryEvidenceDigests(
      memories.map((result) => result.memory.id),
      ownerId,
    );
    const entries: string[] = [];
    let used = 0;
    for (const [index, result] of memories.entries()) {
      const layer = memoryLayerContextFields(result.memory.source);
      const digest = digests.get(result.memory.id);
      const versionId = digest?.versionId || null;
      const sourceSummary = digest?.evidence.length
        ? digest.evidence
            .slice(0, 2)
            .map((source) => {
              const reference =
                source.turnId ||
                source.sourceRef ||
                'internal';
              return `${source.evidenceType}@${reference}`;
            })
            .join(', ')
        : `${result.memory.source}` +
          (result.memory.sourceRef
            ? `@${result.memory.sourceRef}`
            : '');
      // bi-temporal 作答侧：透出事实的发生时间与有效期窗口，让上层作答模型
      // 能区分"现在是 X、之前是 Y"，而不是把新旧事实混为一谈。
      const validity = result.memory.validTo
        ? `${result.memory.validFrom || '不早于录入'} ~ ${result.memory.validTo}（此后已被新事实取代，属历史事实）`
        : result.memory.validFrom
          ? `${result.memory.validFrom} ~ 至今有效`
          : result.memory.status === 'superseded'
            ? '未声明（已被更新版本取代，属历史事实）'
            : '未声明（视为至今有效）';
      const entry = [
        `${layer.heading} ${index + 1}`,
        `memory_id: ${result.memory.id}`,
        `version_id: ${versionId || 'legacy-unversioned'}`,
        `类型/作用域: ${result.memory.kind}/${result.memory.namespace}`,
        `来源摘要: ${sourceSummary}`,
        ...(digest ? [evidenceDigestText(digest)] : []),
        `${layer.contentLabel}: ${result.memory.content}`,
        `发生时间: ${result.memory.occurredAt || '未声明'}`,
        `有效期: ${validity}`,
        ...(layer.caution ? [`使用约束: ${layer.caution}`] : []),
        `置信度/召回分: ${result.memory.confidence.toFixed(2)}/${result.score.toFixed(2)}`,
        `召回依据: ${result.reasons.slice(0, 4).join('；')}`,
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

  private recallResultDetails(
    results: RecallResult[],
    ownerId: string,
  ): Array<{
    memoryId: string;
    versionId: string | null;
    memoryLayer: ReturnType<typeof classifyMemoryLayer>;
    score: number;
    reasons: string[];
    explanation: RecallResult['explanation'];
  }> {
    const currentVersion = this.database.prepare(
      `SELECT current_version_id
       FROM memory_items
       WHERE id = ? AND user_id = ?`,
    );
    return results.map((result) => {
      const row = currentVersion.get(
        result.memory.id,
        ownerId,
      ) as DatabaseRow | undefined;
      return {
        memoryId: result.memory.id,
        versionId: row
          ? asString(row.current_version_id) || null
          : null,
        memoryLayer: classifyMemoryLayer(result.memory.source),
        score: result.score,
        reasons: result.reasons,
        explanation: result.explanation,
      };
    });
  }

  private memoryGroundingSources(
    memories: RecallResult[],
    ownerId: string,
    evidenceDigests?: Map<string, MemoryEvidenceDigest>,
  ): Array<{
    memoryId: string;
    versionId: string | null;
    evidence: Array<{
      evidenceType: string;
      turnId: string | null;
      sourceRef: string | null;
    }>;
    proofCount: number;
    firstEvidenceAt: string | null;
    lastEvidenceAt: string | null;
    excerpts: string[];
  }> {
    const digests = evidenceDigests || this.memoryEvidenceDigests(
      memories.map((result) => result.memory.id),
      ownerId,
    );
    return memories.map((result) => {
      const digest = digests.get(result.memory.id);
      return {
        memoryId: result.memory.id,
        versionId: digest?.versionId || null,
        evidence: digest?.evidence || [],
        proofCount: digest?.proofCount || 0,
        firstEvidenceAt: digest?.firstEvidenceAt || null,
        lastEvidenceAt: digest?.lastEvidenceAt || null,
        excerpts: digest?.excerpts || [],
      };
    });
  }

  applyScopePrecedence(
    ranked: RecallResult[],
  ): {
    results: RecallResult[];
    suppressedCount: number;
  } {
    if (ranked.length < 2) {
      return { results: ranked, suppressedCount: 0 };
    }
    const ids = [...new Set(
      ranked.map((result) => result.memory.id),
    )];
    const rows = this.database
      .prepare(
        `SELECT id, predicate_key
         FROM memory_items
         WHERE id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids) as DatabaseRow[];
    const predicateById = new Map(
      rows
        .map((row) => [
          asString(row.id),
          asString(row.predicate_key).trim(),
        ] as const)
        .filter(([, predicate]) => predicate.length > 0),
    );
    const maximumPriority = new Map<string, number>();
    for (const result of ranked) {
      const predicate = predicateById.get(result.memory.id);
      if (!predicate) continue;
      maximumPriority.set(
        predicate,
        Math.max(
          maximumPriority.get(predicate) ??
            Number.NEGATIVE_INFINITY,
          SCOPE_PRECEDENCE[result.memory.scopeType],
        ),
      );
    }
    const results = ranked.filter((result) => {
      const predicate = predicateById.get(result.memory.id);
      if (!predicate) return true;
      return SCOPE_PRECEDENCE[result.memory.scopeType] ===
        maximumPriority.get(predicate);
    });
    return {
      results,
      suppressedCount: ranked.length - results.length,
    };
  }

  private collapseCoveredAtomicResults(
    ranked: RecallResult[],
  ): {
    results: RecallResult[];
    suppressedCount: number;
  } {
    if (ranked.length < 2) {
      return { results: ranked, suppressedCount: 0 };
    }
    const byId = new Map(
      ranked.map((result) => [result.memory.id, result]),
    );
    const derivedIds = ranked
      .filter((result) => result.memory.source === 'consolidation')
      .map((result) => result.memory.id);
    if (derivedIds.length === 0) {
      return { results: ranked, suppressedCount: 0 };
    }
    const rows = this.database
      .prepare(
        `SELECT DISTINCT
           d.memory_id AS derived_memory_id,
           v.memory_item_id AS source_memory_id
         FROM derived_consolidations d
         JOIN derived_consolidation_sentences sentence
           ON sentence.consolidation_id = d.id
          AND sentence.supported = 1
         JOIN derived_sentence_sources sentence_source
           ON sentence_source.sentence_id = sentence.id
         JOIN memory_versions v
           ON v.id = sentence_source.memory_version_id
         WHERE d.status = 'active'
           AND d.memory_id IN (
             ${derivedIds.map(() => '?').join(', ')}
           )
           AND NOT EXISTS (
             SELECT 1
             FROM derived_consolidation_sentences sentence
             WHERE sentence.consolidation_id = d.id
               AND sentence.supported = 0
           )`,
      )
      .all(...derivedIds) as DatabaseRow[];
    const suppressed = new Set<string>();
    const coveredCount = new Map<string, number>();
    for (const row of rows) {
      const derivedId = asString(row.derived_memory_id);
      const sourceId = asString(row.source_memory_id);
      const derived = byId.get(derivedId);
      const source = byId.get(sourceId);
      if (
        !derived ||
        !source ||
        derived.score + 0.05 < source.score
      ) {
        continue;
      }
      suppressed.add(sourceId);
      coveredCount.set(
        derivedId,
        (coveredCount.get(derivedId) || 0) + 1,
      );
    }
    if (suppressed.size === 0) {
      return { results: ranked, suppressedCount: 0 };
    }
    return {
      results: ranked
        .filter((result) => !suppressed.has(result.memory.id))
        .map((result) => {
          const count = coveredCount.get(result.memory.id) || 0;
          return count > 0
            ? {
                ...result,
                reasons: [
                  ...result.reasons,
                  `有效派生摘要覆盖 ${count} 条原子事实`,
                ],
              }
            : result;
        }),
      suppressedCount: suppressed.size,
    };
  }

  addRelation(
    fromMemoryId: string,
    toMemoryId: string,
    relationType: string,
    userId = config.defaultUserId,
  ): void {
    const relation = cleanText(relationType);
    if (!relation) throw new Error('关系类型不能为空');
    const ownerId = cleanUserId(userId);
    if (
      !this.get(fromMemoryId, true, ownerId) ||
      !this.get(toMemoryId, true, ownerId)
    ) {
      throw new Error('关系记忆不存在或不属于当前用户');
    }
    const createdAt = now();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO memory_relations
          (from_memory_id, to_memory_id, relation_type, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(fromMemoryId, toMemoryId, relation, createdAt);
    this.journal.recordEdge(
      fromMemoryId,
      toMemoryId,
      relation,
      createdAt,
    );
  }

  relations(
    id: string,
    userId = config.defaultUserId,
  ): Array<{
    fromMemoryId: string;
    toMemoryId: string;
    relationType: string;
    createdAt: string;
  }> {
    const rows = this.database
      .prepare(
        `SELECT r.*
         FROM memory_relations r
         JOIN memories source ON source.id = r.from_memory_id
         JOIN memories target ON target.id = r.to_memory_id
         WHERE (r.from_memory_id = ? OR r.to_memory_id = ?)
           AND source.user_id = ? AND target.user_id = ?
         ORDER BY r.created_at DESC`,
      )
      .all(id, id, cleanUserId(userId), cleanUserId(userId)) as DatabaseRow[];
    return rows.map((row) => ({
      fromMemoryId: asString(row.from_memory_id),
      toMemoryId: asString(row.to_memory_id),
      relationType: asString(row.relation_type),
      createdAt: asString(row.created_at),
    }));
  }

  history(
    id: string,
    userId = config.defaultUserId,
  ): MemoryVersionRecord[] {
    if (!this.get(id, true, cleanUserId(userId))) {
      throw new Error('记忆不存在或不属于当前用户');
    }
    return this.journal.history(id);
  }

  audits(
    limit = 100,
    offset = 0,
    userId = config.defaultUserId,
  ): AuditRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM audit_log
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(
        cleanUserId(userId),
        Math.max(1, Math.min(limit, 500)),
        Math.max(0, offset),
      ) as DatabaseRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      action: asString(row.action),
      memoryId: asNullableString(row.memory_id),
      userId: asString(row.user_id),
      detail: parseJson<Record<string, unknown>>(row.detail_json, {}),
      createdAt: asString(row.created_at),
    }));
  }

  stats(userId = config.defaultUserId): MemoryStats {
    const rows = this.database
      .prepare(
        `SELECT status, kind, namespace, COUNT(*) AS count
         FROM memories
         WHERE user_id = ?
         GROUP BY status, kind, namespace`,
      )
      .all(userId) as DatabaseRow[];
    const stats: MemoryStats = {
      total: 0,
      active: 0,
      archived: 0,
      superseded: 0,
      deleted: 0,
      byKind: {},
      byNamespace: {},
    };

    for (const row of rows) {
      const count = Number(row.count);
      const status = asString(row.status) as keyof Pick<
        MemoryStats,
        'active' | 'archived' | 'superseded' | 'deleted'
      >;
      stats.total += count;
      if (status in stats && typeof stats[status] === 'number') {
        stats[status] += count;
      }
      const kind = asString(row.kind);
      const namespace = asString(row.namespace);
      stats.byKind[kind] = (stats.byKind[kind] || 0) + count;
      stats.byNamespace[namespace] =
        (stats.byNamespace[namespace] || 0) + count;
    }
    return stats;
  }

  exportAll(userId = config.defaultUserId): MemoryBackup {
    const ownerId = cleanUserId(userId);
    this.database.exec('BEGIN');
    try {
      const memoryRows = this.database
        .prepare(
          `SELECT * FROM memories
           WHERE user_id = ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(ownerId) as DatabaseRow[];
      const relationRows = this.database
        .prepare(
          `SELECT r.*
           FROM memory_relations r
           JOIN memories source ON source.id = r.from_memory_id
           JOIN memories target ON target.id = r.to_memory_id
           WHERE source.user_id = ? AND target.user_id = ?
           ORDER BY r.created_at ASC, r.id ASC`,
        )
        .all(ownerId, ownerId) as DatabaseRow[];
      const auditRows = this.database
        .prepare(
          `SELECT * FROM audit_log
           WHERE user_id = ?
           ORDER BY id ASC`,
        )
        .all(ownerId) as DatabaseRow[];
      const idempotencyRows = this.database
        .prepare(
          `SELECT * FROM idempotency_keys
           WHERE user_id = ?
           ORDER BY created_at ASC, namespace ASC, key ASC`,
        )
        .all(ownerId) as DatabaseRow[];

      const backup: MemoryBackup = {
        version: 3,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: now(),
        userId: ownerId,
        memories: memoryRows.map(rowToMemory),
        relations: relationRows.map((row) => ({
          fromMemoryId: asString(row.from_memory_id),
          toMemoryId: asString(row.to_memory_id),
          relationType: asString(row.relation_type),
          createdAt: asString(row.created_at),
        })),
        auditLog: auditRows.map((row) => ({
          id: Number(row.id),
          action: asString(row.action),
          memoryId: asNullableString(row.memory_id),
          userId: asString(row.user_id),
          detail: parseJson<Record<string, unknown>>(
            row.detail_json,
            {},
          ),
          createdAt: asString(row.created_at),
        })),
        idempotencyKeys: idempotencyRows.map((row) => ({
          userId: asString(row.user_id),
          namespace: asString(row.namespace),
          scopeType: asString(row.scope_type) || 'personal',
          scopeKey: asString(row.scope_key) || 'self',
          key: asString(row.key),
          memoryId: asString(row.memory_id),
          createdAt: asString(row.created_at),
        })),
        state: this.exportFullState(ownerId),
      };
      this.database.exec('COMMIT');
      return backup;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private exportFullState(ownerId: string): FullBackupState {
    const rows = (
      sql: string,
      ...values: SQLInputValue[]
    ): Array<Record<string, string | number | null>> =>
      (
        this.database.prepare(sql).all(...values) as DatabaseRow[]
      ).map((row) => {
        const plain: Record<string, string | number | null> = {};
        for (const [key, value] of Object.entries(row)) {
          if (
            value === null ||
            typeof value === 'string' ||
            typeof value === 'number'
          ) {
            plain[key] = value;
            continue;
          }
          throw new Error(
            `完整备份表字段 ${key} 包含不可序列化值`,
          );
        }
        return plain;
      });

    return {
      sessions: rows(
        `SELECT *
         FROM conversation_sessions
         WHERE user_id = ?
         ORDER BY started_at ASC, id ASC`,
        ownerId,
      ),
      turns: rows(
        `SELECT *
         FROM conversation_turns
         WHERE user_id = ?
         ORDER BY occurred_at ASC, id ASC`,
        ownerId,
      ),
      extractionRuns: rows(
        `SELECT r.*
         FROM extraction_runs r
         JOIN conversation_turns t ON t.id = r.turn_id
         WHERE t.user_id = ?
         ORDER BY r.created_at ASC, r.id ASC`,
        ownerId,
      ),
      candidates: rows(
        `SELECT *
         FROM memory_candidates
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      actionRequests: rows(
        `SELECT *
         FROM memory_action_requests
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      candidateResolutionRuns: rows(
        `SELECT r.*
         FROM candidate_resolution_runs r
         JOIN memory_candidates c ON c.id = r.candidate_id
         WHERE c.user_id = ?
         ORDER BY r.created_at ASC, r.id ASC`,
        ownerId,
      ),
      items: rows(
        `SELECT *
         FROM memory_items
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      versions: rows(
        `SELECT v.*
         FROM memory_versions v
         JOIN memory_items i ON i.id = v.memory_item_id
         WHERE i.user_id = ?
         ORDER BY v.created_at ASC, v.id ASC`,
        ownerId,
      ),
      evidence: rows(
        `SELECT e.*
         FROM memory_evidence e
         JOIN memory_versions v ON v.id = e.memory_version_id
         JOIN memory_items i ON i.id = v.memory_item_id
         WHERE i.user_id = ?
         ORDER BY e.created_at ASC, e.id ASC`,
        ownerId,
      ),
      edges: rows(
        `SELECT e.*
         FROM memory_edges e
         JOIN memory_items source
           ON source.id = e.from_memory_item_id
         JOIN memory_items target
           ON target.id = e.to_memory_item_id
         WHERE source.user_id = ? AND target.user_id = ?
         ORDER BY e.created_at ASC, e.id ASC`,
        ownerId,
        ownerId,
      ),
      events: rows(
        `SELECT *
         FROM memory_events
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      outbox: rows(
        `SELECT o.*
         FROM outbox_events o
         WHERE o.user_id = ?
           AND (
             (
               o.aggregate_type = 'turn'
               AND EXISTS (
                 SELECT 1
                 FROM conversation_turns t
                 WHERE t.id = o.aggregate_id
                   AND t.user_id = o.user_id
                   AND t.namespace = o.namespace
               )
             ) OR (
               o.aggregate_type = 'memory_candidate'
               AND EXISTS (
                 SELECT 1
                 FROM memory_candidates c
                 WHERE c.id = o.aggregate_id
                   AND c.user_id = o.user_id
                   AND c.namespace = o.namespace
               )
             ) OR (
               o.aggregate_type = 'memory_event'
               AND EXISTS (
                 SELECT 1
                 FROM memory_events e
                 JOIN memory_items i ON i.id = e.memory_item_id
                 WHERE e.id = o.aggregate_id
                   AND e.user_id = o.user_id
                   AND i.user_id = o.user_id
                   AND i.namespace = o.namespace
               )
             )
           )
         ORDER BY o.created_at ASC, o.id ASC`,
        ownerId,
      ),
      jobs: rows(
        `SELECT *
         FROM memory_jobs
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      deadLetters: rows(
        `SELECT *
         FROM dead_letter_jobs
         WHERE user_id = ?
         ORDER BY failed_at ASC, job_id ASC`,
        ownerId,
      ),
      retentionPolicies: rows(
        `SELECT *
         FROM retention_policies
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      tombstones: rows(
        `SELECT *
         FROM memory_tombstones
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      consolidations: rows(
        `SELECT *
         FROM derived_consolidations
         WHERE user_id = ?
         ORDER BY generated_at ASC, id ASC`,
        ownerId,
      ),
      consolidationSources: rows(
        `SELECT s.*
         FROM derived_consolidation_sources s
         JOIN derived_consolidations d
           ON d.id = s.consolidation_id
         WHERE d.user_id = ?
         ORDER BY s.consolidation_id ASC, s.memory_version_id ASC`,
        ownerId,
      ),
      consolidationSentences: rows(
        `SELECT s.*
         FROM derived_consolidation_sentences s
         JOIN derived_consolidations d
           ON d.id = s.consolidation_id
         WHERE d.user_id = ?
         ORDER BY s.consolidation_id ASC, s.sentence_index ASC`,
        ownerId,
      ),
      sentenceSources: rows(
        `SELECT ss.*
         FROM derived_sentence_sources ss
         JOIN derived_consolidation_sentences s
           ON s.id = ss.sentence_id
         JOIN derived_consolidations d
           ON d.id = s.consolidation_id
         WHERE d.user_id = ?
         ORDER BY ss.sentence_id ASC, ss.memory_version_id ASC`,
        ownerId,
      ),
      purgeJobs: rows(
        `SELECT *
         FROM purge_jobs
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      namespaceQualitySnapshots: rows(
        `SELECT *
         FROM namespace_quality_snapshots
         WHERE user_id = ?
         ORDER BY evaluated_at ASC, created_at ASC, id ASC`,
        ownerId,
      ),
      namespaceRolloutState: rows(
        `SELECT *
         FROM namespace_rollout_state
         WHERE user_id = ?
         ORDER BY namespace ASC`,
        ownerId,
      ),
      namespaceRecallShadowComparisons: rows(
        `SELECT *
         FROM namespace_recall_shadow_comparisons
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      turnIngestOrder: rows(
        `SELECT *
         FROM memory_turn_ingest_order
         WHERE user_id = ?
         ORDER BY ingest_seq ASC`,
        ownerId,
      ),
      reflectionSettings: rows(
        `SELECT *
         FROM memory_reflection_settings
         WHERE user_id = ?
         ORDER BY namespace ASC`,
        ownerId,
      ),
      reflectionCheckpoints: rows(
        `SELECT *
         FROM memory_reflection_checkpoints
         WHERE user_id = ?
         ORDER BY namespace, scope_type, scope_key, run_type, generation_key`,
        ownerId,
      ),
      reflectionRuns: rows(
        `SELECT *
         FROM memory_reflection_runs
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      reflectionRunTurns: rows(
        `SELECT rt.*
         FROM memory_reflection_run_turns rt
         JOIN memory_reflection_runs r ON r.id = rt.run_id
         WHERE r.user_id = ?
         ORDER BY rt.run_id ASC, rt.ordinal ASC`,
        ownerId,
      ),
      reflectionModelCalls: rows(
        `SELECT *
         FROM memory_reflection_model_calls
         WHERE user_id = ?
         ORDER BY reserved_at ASC, id ASC`,
        ownerId,
      ),
      reflectionClaims: rows(
        `SELECT *
         FROM memory_reflection_claims
         WHERE user_id = ?
         ORDER BY namespace, scope_type, scope_key, claim_fingerprint`,
        ownerId,
      ),
      reflectionEvents: rows(
        `SELECT *
         FROM memory_reflection_events
         WHERE user_id = ?
         ORDER BY id ASC`,
        ownerId,
      ),
      candidateEvidence: rows(
        `SELECT e.*
         FROM memory_candidate_evidence e
         JOIN memory_candidates c ON c.id = e.candidate_id
         WHERE c.user_id = ?
         ORDER BY e.candidate_id ASC, e.ordinal ASC, e.turn_id ASC`,
        ownerId,
      ),
      episodes: rows(
        `SELECT *
         FROM conversation_episodes
         WHERE user_id = ?
         ORDER BY occurred_at ASC, id ASC`,
        ownerId,
      ),
      episodeTurns: rows(
        `SELECT link.*
         FROM conversation_episode_turns link
         JOIN conversation_episodes episode
           ON episode.id = link.episode_id
         WHERE episode.user_id = ?
         ORDER BY link.episode_id ASC, link.ordinal ASC`,
        ownerId,
      ),
      patternObservations: rows(
        `SELECT *
         FROM memory_pattern_observations
         WHERE user_id = ?
         ORDER BY occurred_at ASC, id ASC`,
        ownerId,
      ),
      hierarchicalSummaries: rows(
        `SELECT *
         FROM conversation_memory_summaries
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        ownerId,
      ),
      hierarchicalSummarySources: rows(
        `SELECT source.*
         FROM conversation_memory_summary_sources source
         JOIN conversation_memory_summaries summary
           ON summary.id = source.summary_id
         WHERE summary.user_id = ?
         ORDER BY source.summary_id ASC, source.ordinal ASC`,
        ownerId,
      ),
    };
  }

  importAll(
    payload: unknown,
    userId = config.defaultUserId,
  ): {
    imported: number;
    deduplicated: number;
    skipped: number;
    relationCount: number;
    auditCount: number;
    idempotencyKeyCount: number;
    stateRowCount?: number;
  } {
    const ownerId = cleanUserId(userId);
    const backup = validateBackup(payload, ownerId);
    if (backup.version === 3) {
      return this.importFullBackup(backup, ownerId);
    }
    const insertMemory = this.database.prepare(`
      INSERT INTO memories (
        id, user_id, namespace, kind, title, content, summary,
        tags_json, importance, confidence, status, source, source_ref,
        occurred_at, valid_from, valid_to, created_at, updated_at,
        last_seen_at, last_accessed_at, access_count, checksum, embedding,
        deleted_at, scope_type, scope_key, sensitivity, source_authority,
        negated, origin, corpus_domain, classification
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    const insertRelation = this.database.prepare(`
      INSERT INTO memory_relations (
        from_memory_id, to_memory_id, relation_type, created_at
      ) VALUES (?, ?, ?, ?)
    `);
    const insertAudit = this.database.prepare(`
      INSERT INTO audit_log (
        id, action, memory_id, user_id, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertIdempotencyKey = this.database.prepare(`
      INSERT INTO idempotency_keys (
        user_id, namespace, scope_type, scope_key, key,
        memory_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const tombstoneLedger =
        this.tombstoneLedgerForBackupImport(ownerId);
      this.journal.resetUser(ownerId);
      this.database
        .prepare('DELETE FROM audit_log WHERE user_id = ?')
        .run(ownerId);
      this.database
        .prepare(
          `DELETE FROM memory_relations
           WHERE from_memory_id IN (
             SELECT id FROM memories WHERE user_id = ?
           ) OR to_memory_id IN (
             SELECT id FROM memories WHERE user_id = ?
           )`,
        )
        .run(ownerId, ownerId);
      this.database
        .prepare('DELETE FROM memories WHERE user_id = ?')
        .run(ownerId);

      for (const memory of backup.memories) {
        insertMemory.run(
          memory.id,
          memory.userId,
          memory.namespace,
          memory.kind,
          memory.title,
          memory.content,
          memory.summary,
          JSON.stringify(memory.tags),
          memory.importance,
          memory.confidence,
          memory.status,
          memory.source,
          memory.sourceRef,
          memory.occurredAt,
          memory.validFrom,
          memory.validTo,
          memory.createdAt,
          memory.updatedAt,
          memory.lastSeenAt,
          memory.lastAccessedAt,
          memory.accessCount,
          memory.checksum,
          vectorToBuffer(embedText(memoryText(memory))),
          memory.deletedAt,
          memory.scopeType,
          memory.scopeKey,
          memory.sensitivity,
          memory.sourceAuthority,
          memory.negated ? 1 : 0,
          memory.origin ?? 'pipeline',
          normalizeCorpusDomain(memory.corpusDomain),
          normalizeClassification(memory.classification),
        );
        this.journal.recordCreate(
          memory,
          'backup-import',
          'imported',
          `legacy:${memory.id}`,
        );
      }
      for (const relation of backup.relations) {
        insertRelation.run(
          relation.fromMemoryId,
          relation.toMemoryId,
          relation.relationType,
          relation.createdAt,
        );
        this.journal.recordEdge(
          relation.fromMemoryId,
          relation.toMemoryId,
          relation.relationType,
          relation.createdAt,
        );
      }
      for (const entry of backup.idempotencyKeys) {
        insertIdempotencyKey.run(
          entry.userId,
          entry.namespace,
          entry.scopeType ?? 'personal',
          entry.scopeKey ?? 'self',
          entry.key,
          entry.memoryId,
          entry.createdAt,
        );
      }
      for (const audit of backup.auditLog) {
        insertAudit.run(
          audit.id,
          audit.action,
          audit.memoryId,
          audit.userId,
          JSON.stringify(audit.detail),
          audit.createdAt,
        );
      }
      this.restoreTombstoneLedgerAfterBackupImport(
        ownerId,
        tombstoneLedger,
      );
      for (const memory of backup.memories) {
        const imported = this.get(memory.id, true, ownerId);
        if (imported && imported.status !== 'deleted') {
          this.indexMemory(imported);
        }
      }
      this.reconcileImportedMemoriesWithTombstones(ownerId);
      this.enqueueDenseRebuildJobs(ownerId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    return {
      imported: backup.memories.length,
      deduplicated: 0,
      skipped: 0,
      relationCount: backup.relations.length,
      auditCount: backup.auditLog.length,
      idempotencyKeyCount: backup.idempotencyKeys.length,
    };
  }

  private importFullBackup(
    backup: MemoryBackup,
    ownerId: string,
  ): {
    imported: number;
    deduplicated: number;
    skipped: number;
    relationCount: number;
    auditCount: number;
    idempotencyKeyCount: number;
    stateRowCount: number;
  } {
    if (backup.version !== 3 || !backup.state) {
      throw new Error('完整备份缺少状态数据');
    }
    const state = backup.state;
    const insertMemory = this.database.prepare(`
      INSERT INTO memories (
        id, user_id, namespace, kind, title, content, summary,
        tags_json, importance, confidence, status, source, source_ref,
        occurred_at, valid_from, valid_to, created_at, updated_at,
        last_seen_at, last_accessed_at, access_count, checksum, embedding,
        deleted_at, scope_type, scope_key, sensitivity, source_authority,
        negated, origin, corpus_domain, classification
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    const insertRelation = this.database.prepare(`
      INSERT INTO memory_relations (
        from_memory_id, to_memory_id, relation_type, created_at
      ) VALUES (?, ?, ?, ?)
    `);
    const insertAudit = this.database.prepare(`
      INSERT INTO audit_log (
        id, action, memory_id, user_id, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertIdempotencyKey = this.database.prepare(`
      INSERT INTO idempotency_keys (
        user_id, namespace, scope_type, scope_key, key,
        memory_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.assertTrustedFullBackupIdentityBindings(state, ownerId);
      const tombstoneLedger =
        this.tombstoneLedgerForBackupImport(ownerId);
      this.clearUserForFullImport(ownerId);
      for (const memory of backup.memories) {
        insertMemory.run(
          memory.id,
          memory.userId,
          memory.namespace,
          memory.kind,
          memory.title,
          memory.content,
          memory.summary,
          JSON.stringify(memory.tags),
          memory.importance,
          memory.confidence,
          memory.status,
          memory.source,
          memory.sourceRef,
          memory.occurredAt,
          memory.validFrom,
          memory.validTo,
          memory.createdAt,
          memory.updatedAt,
          memory.lastSeenAt,
          memory.lastAccessedAt,
          memory.accessCount,
          memory.checksum,
          vectorToBuffer(embedText(memoryText(memory))),
          memory.deletedAt,
          memory.scopeType,
          memory.scopeKey,
          memory.sensitivity,
          memory.sourceAuthority,
          memory.negated ? 1 : 0,
          memory.origin ?? 'pipeline',
          normalizeCorpusDomain(memory.corpusDomain),
          normalizeClassification(memory.classification),
        );
      }

      this.insertBackupRows(
        'conversation_sessions',
        state.sessions,
      );
      this.insertBackupRows('conversation_turns', state.turns);
      this.restoreImportedConversationSessionRollups(state.sessions);
      this.insertBackupRows(
        'extraction_runs',
        state.extractionRuns,
      );
      this.remapReflectionIngestStateForImport(state, ownerId);
      this.insertBackupRows(
        'memory_reflection_settings',
        state.reflectionSettings,
      );
      this.insertBackupRows(
        'memory_reflection_checkpoints',
        state.reflectionCheckpoints,
      );
      this.insertBackupRows(
        'memory_reflection_runs',
        state.reflectionRuns,
      );
      this.insertBackupRows(
        'memory_reflection_run_turns',
        state.reflectionRunTurns,
      );
      this.insertBackupRows(
        'memory_reflection_model_calls',
        state.reflectionModelCalls,
      );
      this.insertBackupRows('memory_items', state.items);
      this.insertBackupRows('memory_versions', state.versions);
      this.insertBackupRows('memory_evidence', state.evidence);
      this.insertBackupRows('memory_candidates', state.candidates);
      this.insertBackupRows(
        'memory_candidate_evidence',
        state.candidateEvidence,
      );
      this.insertBackupRows(
        'memory_reflection_claims',
        state.reflectionClaims,
      );
      this.insertBackupRows(
        'memory_reflection_events',
        state.reflectionEvents,
      );
      this.insertBackupRows(
        'conversation_episodes',
        state.episodes,
      );
      this.insertBackupRows(
        'conversation_episode_turns',
        state.episodeTurns,
      );
      this.insertBackupRows(
        'memory_pattern_observations',
        state.patternObservations,
      );
      this.insertBackupRows(
        'conversation_memory_summaries',
        state.hierarchicalSummaries,
      );
      this.insertBackupRows(
        'conversation_memory_summary_sources',
        state.hierarchicalSummarySources,
      );
      this.insertBackupRows(
        'memory_action_requests',
        state.actionRequests,
      );
      this.insertBackupRows(
        'candidate_resolution_runs',
        state.candidateResolutionRuns,
      );
      this.insertBackupRows('memory_edges', state.edges);
      this.insertBackupRows('memory_events', state.events);
      this.insertBackupRows(
        'derived_consolidations',
        state.consolidations,
      );
      this.insertBackupRows(
        'derived_consolidation_sources',
        state.consolidationSources,
      );
      this.insertBackupRows(
        'derived_consolidation_sentences',
        state.consolidationSentences,
      );
      this.insertBackupRows(
        'derived_sentence_sources',
        state.sentenceSources,
      );
      this.insertBackupRows(
        'namespace_quality_snapshots',
        state.namespaceQualitySnapshots,
      );
      this.insertBackupRows(
        'namespace_rollout_state',
        state.namespaceRolloutState,
      );
      this.insertBackupRows(
        'namespace_recall_shadow_comparisons',
        state.namespaceRecallShadowComparisons,
      );

      for (const relation of backup.relations) {
        insertRelation.run(
          relation.fromMemoryId,
          relation.toMemoryId,
          relation.relationType,
          relation.createdAt,
        );
      }
      for (const entry of backup.idempotencyKeys) {
        insertIdempotencyKey.run(
          entry.userId,
          entry.namespace,
          entry.scopeType ?? 'personal',
          entry.scopeKey ?? 'self',
          entry.key,
          entry.memoryId,
          entry.createdAt,
        );
      }
      for (const audit of backup.auditLog) {
        insertAudit.run(
          audit.id,
          audit.action,
          audit.memoryId,
          audit.userId,
          JSON.stringify(audit.detail),
          audit.createdAt,
        );
      }

      this.database
        .prepare('DELETE FROM memory_jobs WHERE user_id = ?')
        .run(ownerId);
      this.insertBackupRows('outbox_events', state.outbox);
      this.insertBackupRows('memory_jobs', state.jobs);
      this.insertBackupRows(
        'dead_letter_jobs',
        state.deadLetters,
      );
      this.insertBackupRows(
        'retention_policies',
        state.retentionPolicies,
      );
      this.insertBackupRows(
        'memory_tombstones',
        state.tombstones,
      );
      this.insertBackupRows('purge_jobs', state.purgeJobs);

      this.restoreTombstoneLedgerAfterBackupImport(
        ownerId,
        tombstoneLedger,
      );
      for (const memory of backup.memories) {
        const imported = this.get(memory.id, true, ownerId);
        if (imported && imported.status !== 'deleted') {
          this.indexMemory(imported);
        }
      }
      this.reconcileImportedMemoriesWithTombstones(ownerId);
      this.enqueueDenseRebuildJobs(ownerId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    const stateRowCount = Object.values(state).reduce(
      (total, rows) => total + rows.length,
      0,
    );
    return {
      imported: backup.memories.length,
      deduplicated: 0,
      skipped: 0,
      relationCount: backup.relations.length,
      auditCount: backup.auditLog.length,
      idempotencyKeyCount: backup.idempotencyKeys.length,
      stateRowCount,
    };
  }

  private assertTrustedFullBackupIdentityBindings(
    state: FullBackupState,
    ownerId: string,
  ): void {
    const findTrustedSession = this.database.prepare(
      `SELECT namespace, persona_id, project_id, identity_status
       FROM conversation_sessions
       WHERE user_id = ? AND client_name = ? AND external_id = ?`,
    );
    for (const session of state.sessions) {
      if (rowText(session, 'identity_status') !== 'complete') {
        continue;
      }
      const trusted = findTrustedSession.get(
        ownerId,
        rowText(session, 'client_name'),
        rowText(session, 'external_id'),
      ) as DatabaseRow | undefined;
      if (
        !trusted ||
        asString(trusted.identity_status) !== 'complete' ||
        asString(trusted.namespace) !== rowText(session, 'namespace') ||
        asNullableString(trusted.persona_id) !==
          optionalRowText(session, 'persona_id') ||
        asNullableString(trusted.project_id) !==
          optionalRowText(session, 'project_id')
      ) {
        throw new Error(
          '完整备份身份绑定未经目标库信任或与现有绑定不一致；请先隔离（quarantine）并显式重绑（rebind）',
        );
      }
    }
  }

  private tombstoneLedgerForBackupImport(
    ownerId: string,
  ): FullBackupState['tombstones'] {
    return this.database
      .prepare(
        `SELECT *
         FROM memory_tombstones
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(ownerId) as FullBackupState['tombstones'];
  }

  private restoreTombstoneLedgerAfterBackupImport(
    ownerId: string,
    tombstones: FullBackupState['tombstones'],
  ): void {
    for (const tombstone of tombstones) {
      const id = rowText(tombstone, 'id');
      const memoryItemId = optionalRowText(
        tombstone,
        'memory_item_id',
      );
      const generation = Number(
        tombstone.deletion_generation ?? 1,
      );
      if (
        !id ||
        rowText(tombstone, 'user_id') !== ownerId ||
        !Number.isInteger(generation) ||
        generation < 1
      ) {
        throw new Error('目标库包含无效的 tombstone 账本');
      }

      const existing = this.database
        .prepare(
          `SELECT user_id, namespace, memory_item_id,
                  deletion_generation
           FROM memory_tombstones
           WHERE id = ?`,
        )
        .get(id) as DatabaseRow | undefined;
      if (
        existing &&
        (
          asString(existing.user_id) !== ownerId ||
          asString(existing.namespace) !==
            rowText(tombstone, 'namespace') ||
          asNullableString(existing.memory_item_id) !== memoryItemId ||
          Number(existing.deletion_generation) !== generation
        )
      ) {
        throw new Error(
          `tombstone ${id} 与备份中的删除世代冲突`,
        );
      }

      if (memoryItemId) {
        const generationConflict = this.database
          .prepare(
            `SELECT id
             FROM memory_tombstones
             WHERE memory_item_id = ?
               AND deletion_generation = ?
               AND id != ?
             LIMIT 1`,
          )
          .get(memoryItemId, generation, id) as
            | DatabaseRow
            | undefined;
        if (generationConflict) {
          throw new Error(
            `记忆 ${memoryItemId} 的删除世代 ${generation} 冲突`,
          );
        }
      }
    }

    const deleteImportedCopy = this.database.prepare(
      'DELETE FROM memory_tombstones WHERE id = ?',
    );
    for (const tombstone of tombstones) {
      deleteImportedCopy.run(rowText(tombstone, 'id'));
    }
    this.insertBackupRows('memory_tombstones', tombstones);
  }

  private reconcileImportedMemoriesWithTombstones(
    ownerId: string,
  ): void {
    const importedRows = this.database
      .prepare(
        `SELECT *
         FROM memories
         WHERE user_id = ? AND status != 'deleted'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(ownerId) as DatabaseRow[];
    const itemLookup = this.database.prepare(
      `SELECT stable_key, predicate_key, normalized_value
       FROM memory_items
       WHERE id = ? AND user_id = ?`,
    );
    const directTombstoneLookup = this.database.prepare(
      `SELECT id, created_at
       FROM memory_tombstones
       WHERE user_id = ? AND memory_item_id = ?
         AND restored_at IS NULL
       ORDER BY deletion_generation DESC, created_at DESC, id DESC
       LIMIT 1`,
    );
    const tombstoneLookup = this.database.prepare(
      `SELECT created_at
       FROM memory_tombstones
       WHERE id = ? AND user_id = ? AND restored_at IS NULL`,
    );
    const deleteProjection = this.database.prepare(
      `UPDATE memories
       SET status = 'deleted', deleted_at = ?,
           updated_at = CASE
             WHEN updated_at > ? THEN updated_at
             ELSE ?
           END
       WHERE id = ? AND user_id = ? AND status != 'deleted'`,
    );
    const deleteItem = this.database.prepare(
      `UPDATE memory_items
       SET status = 'deleted',
           updated_at = CASE
             WHEN updated_at > ? THEN updated_at
             ELSE ?
           END
       WHERE id = ? AND user_id = ?`,
    );

    for (const row of importedRows) {
      const memory = rowToMemory(row);
      const item = itemLookup.get(
        memory.id,
        ownerId,
      ) as DatabaseRow | undefined;
      if (!item) {
        throw new Error(
          `导入记忆 ${memory.id} 缺少规范记忆项`,
        );
      }
      const directTombstone = directTombstoneLookup.get(
        ownerId,
        memory.id,
      ) as DatabaseRow | undefined;
      const semanticTombstone = directTombstone
        ? null
        : findBlockingTombstone(this.database, {
            userId: ownerId,
            namespace: memory.namespace,
            scopeType: memory.scopeType,
            scopeKey: memory.scopeKey,
            kind: memory.kind,
            content: memory.content,
            stableKey: asNullableString(item.stable_key),
            normalizedKey: asNullableString(item.predicate_key),
            normalizedValue: asNullableString(item.normalized_value),
          });
      if (!directTombstone && !semanticTombstone) continue;

      const tombstone = directTombstone ||
        tombstoneLookup.get(
          semanticTombstone!.id,
          ownerId,
        ) as DatabaseRow | undefined;
      const deletedAt = asString(tombstone?.created_at);
      if (!deletedAt) {
        throw new Error(
          `阻止导入记忆 ${memory.id} 的 tombstone 无效`,
        );
      }
      const projectionResult = deleteProjection.run(
        deletedAt,
        deletedAt,
        deletedAt,
        memory.id,
        ownerId,
      );
      const itemResult = deleteItem.run(
        deletedAt,
        deletedAt,
        memory.id,
        ownerId,
      );
      if (
        Number(projectionResult.changes) !== 1 ||
        Number(itemResult.changes) !== 1
      ) {
        throw new Error(
          `导入记忆 ${memory.id} 的遗忘状态协调失败`,
        );
      }
      this.removeImportedMemoryIndexes(memory.id);
      this.invalidateImportedConsolidationsForSource(
        memory.id,
        deletedAt,
        ownerId,
      );
    }
  }

  private invalidateImportedConsolidationsForSource(
    sourceMemoryId: string,
    staleAt: string,
    ownerId: string,
  ): void {
    const pending = [sourceMemoryId];
    const visited = new Set<string>();
    const dependentConsolidations = this.database.prepare(
      `SELECT DISTINCT d.id, d.memory_id
       FROM derived_consolidations d
       JOIN derived_consolidation_sources s
         ON s.consolidation_id = d.id
       JOIN memory_versions v ON v.id = s.memory_version_id
       WHERE v.memory_item_id = ? AND d.status = 'active'
       ORDER BY d.id ASC`,
    );
    const staleConsolidation = this.database.prepare(
      `UPDATE derived_consolidations
       SET status = 'stale', stale_at = ?, last_error = NULL
       WHERE id = ? AND status = 'active'`,
    );
    const archiveProjection = this.database.prepare(
      `UPDATE memories
       SET status = 'archived',
           updated_at = CASE
             WHEN updated_at > ? THEN updated_at
             ELSE ?
           END
       WHERE id = ? AND user_id = ? AND status != 'deleted'`,
    );
    const archiveItem = this.database.prepare(
      `UPDATE memory_items
       SET status = 'archived', archived_at = ?,
           archive_reason = 'source_changed',
           updated_at = CASE
             WHEN updated_at > ? THEN updated_at
             ELSE ?
           END
       WHERE id = ? AND user_id = ? AND status != 'deleted'`,
    );

    while (pending.length > 0) {
      const currentSourceId = pending.shift()!;
      if (visited.has(currentSourceId)) continue;
      visited.add(currentSourceId);
      const rows = dependentConsolidations.all(
        currentSourceId,
      ) as DatabaseRow[];
      for (const row of rows) {
        const consolidationId = asString(row.id);
        const derivedMemoryId = asNullableString(row.memory_id);
        const result = staleConsolidation.run(
          staleAt,
          consolidationId,
        );
        if (Number(result.changes) !== 1) {
          throw new Error(
            `派生摘要 ${consolidationId} 的遗忘状态协调失败`,
          );
        }
        if (!derivedMemoryId) continue;
        archiveProjection.run(
          staleAt,
          staleAt,
          derivedMemoryId,
          ownerId,
        );
        const derivedItem = this.database
          .prepare(
            `SELECT id
             FROM memory_items
             WHERE id = ? AND user_id = ?`,
          )
          .get(derivedMemoryId, ownerId);
        if (!derivedItem) {
          throw new Error(
            `派生摘要 ${consolidationId} 缺少规范记忆项`,
          );
        }
        archiveItem.run(
          staleAt,
          staleAt,
          staleAt,
          derivedMemoryId,
          ownerId,
        );
        this.removeImportedMemoryIndexes(derivedMemoryId);
        pending.push(derivedMemoryId);
      }
    }
  }

  private removeImportedMemoryIndexes(memoryId: string): void {
    for (const table of [
      'memory_embeddings',
      'memory_ann_index',
      'memory_term_index',
      'memory_dense_lsh',
      'memories_fts',
    ]) {
      this.database
        .prepare(`DELETE FROM ${table} WHERE memory_id = ?`)
        .run(memoryId);
    }
  }

  private clearUserForFullImport(ownerId: string): void {
    this.database
      .prepare(
        'DELETE FROM conversation_memory_summaries WHERE user_id = ?',
      )
      .run(ownerId);
    this.database
      .prepare(
        'DELETE FROM memory_pattern_observations WHERE user_id = ?',
      )
      .run(ownerId);
    this.database
      .prepare('DELETE FROM conversation_episodes WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_reflection_claims WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_candidate_evidence WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_reflection_events WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_reflection_model_calls WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_reflection_runs WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_reflection_checkpoints WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_reflection_settings WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare(
        `DELETE FROM namespace_recall_shadow_comparisons
         WHERE user_id = ?`,
      )
      .run(ownerId);
    this.database
      .prepare(
        'DELETE FROM namespace_rollout_state WHERE user_id = ?',
      )
      .run(ownerId);
    this.database
      .prepare(
        'DELETE FROM namespace_quality_snapshots WHERE user_id = ?',
      )
      .run(ownerId);
    this.database
      .prepare(
        `DELETE FROM outbox_events
         WHERE user_id = ?
            OR (
              user_id IS NULL
              AND (
                (
                  aggregate_type = 'turn'
                  AND aggregate_id IN (
                    SELECT id
                    FROM conversation_turns
                    WHERE user_id = ?
                  )
                ) OR (
                  aggregate_type = 'memory_candidate'
                  AND aggregate_id IN (
                    SELECT id
                    FROM memory_candidates
                    WHERE user_id = ?
                  )
                ) OR (
                  aggregate_type = 'memory_event'
                  AND aggregate_id IN (
                    SELECT id
                    FROM memory_events
                    WHERE user_id = ?
                  )
                )
              )
            )`,
      )
      .run(ownerId, ownerId, ownerId, ownerId);
    this.database
      .prepare(
        'DELETE FROM derived_consolidations WHERE user_id = ?',
      )
      .run(ownerId);
    this.database
      .prepare('DELETE FROM purge_jobs WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM dead_letter_jobs WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_jobs WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_events WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_action_requests WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_candidates WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare(
        `DELETE FROM extraction_runs
         WHERE turn_id IN (
           SELECT id
           FROM conversation_turns
           WHERE user_id = ?
         )`,
      )
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_items WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare(
        'DELETE FROM conversation_sessions WHERE user_id = ?',
      )
      .run(ownerId);
    this.database
      .prepare('DELETE FROM retention_policies WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM memory_tombstones WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare('DELETE FROM audit_log WHERE user_id = ?')
      .run(ownerId);
    this.database
      .prepare(
        `DELETE FROM memory_relations
         WHERE from_memory_id IN (
           SELECT id FROM memories WHERE user_id = ?
         ) OR to_memory_id IN (
           SELECT id FROM memories WHERE user_id = ?
         )`,
      )
      .run(ownerId, ownerId);
    this.database
      .prepare('DELETE FROM memories WHERE user_id = ?')
      .run(ownerId);
  }

  private remapReflectionIngestStateForImport(
    state: FullBackupState,
    ownerId: string,
  ): void {
    const generatedRows = this.database
      .prepare(
        `SELECT turn_id, ingest_seq
         FROM memory_turn_ingest_order
         WHERE user_id = ?`,
      )
      .all(ownerId) as DatabaseRow[];
    const actualByTurn = new Map<string, number>(
      generatedRows.map((row) => [
        asString(row.turn_id),
        Number(row.ingest_seq),
      ]),
    );
    const oldToActual = new Map<number, number>();
    if (state.turnIngestOrder.length > 0) {
      const occupied = new Set(
        (
          this.database.prepare(
            `SELECT ingest_seq
             FROM memory_turn_ingest_order
             WHERE user_id != ?`,
          ).all(ownerId) as DatabaseRow[]
        ).map((row) => Number(row.ingest_seq)),
      );
      let nextSequence = Math.max(
        0,
        ...occupied,
        ...generatedRows.map((row) => Number(row.ingest_seq)),
      );
      actualByTurn.clear();
      for (const row of [...state.turnIngestOrder].sort(
        (left, right) => Number(left.ingest_seq) - Number(right.ingest_seq),
      )) {
        const oldSequence = Number(row.ingest_seq);
        let actualSequence = oldSequence;
        if (occupied.has(actualSequence)) {
          do {
            nextSequence += 1;
            actualSequence = nextSequence;
          } while (occupied.has(actualSequence));
        }
        occupied.add(actualSequence);
        oldToActual.set(oldSequence, actualSequence);
        actualByTurn.set(rowText(row, 'turn_id'), actualSequence);
        row.ingest_seq = actualSequence;
      }
      this.database
        .prepare('DELETE FROM memory_turn_ingest_order WHERE user_id = ?')
        .run(ownerId);
      const insertIngest = this.database.prepare(
        `INSERT INTO memory_turn_ingest_order (
           ingest_seq, turn_id, session_id, user_id, namespace, ingested_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const row of state.turnIngestOrder) {
        insertIngest.run(
          Number(row.ingest_seq),
          rowText(row, 'turn_id'),
          rowText(row, 'session_id'),
          ownerId,
          rowText(row, 'namespace'),
          rowText(row, 'ingested_at'),
        );
      }
    }

    const turnsByRun = new Map<string, FullBackupRow[]>();
    for (const row of state.reflectionRunTurns) {
      const turnId = rowText(row, 'turn_id');
      const actualSequence = actualByTurn.get(turnId);
      if (!actualSequence) {
        throw new Error(`历史重提炼运行引用了未导入 turn：${turnId}`);
      }
      row.ingest_seq = actualSequence;
      const runId = rowText(row, 'run_id');
      const group = turnsByRun.get(runId) || [];
      group.push(row);
      turnsByRun.set(runId, group);
    }
    for (const run of state.reflectionRuns) {
      const runId = rowText(run, 'id');
      const turns = (turnsByRun.get(runId) || []).sort(
        (left, right) => Number(left.ordinal) - Number(right.ordinal),
      );
      if (turns.length === 0) {
        run.window_start_ingest_seq = null;
        run.window_end_ingest_seq = null;
      } else {
        const sequences = turns.map((row) => Number(row.ingest_seq));
        run.window_start_ingest_seq = Math.min(...sequences);
        run.window_end_ingest_seq = Math.max(...sequences);
      }
      run.turn_set_hash = createHash('sha256')
        .update(turns.map((row) => [
          rowText(row, 'turn_id'),
          Number(row.ingest_seq),
          rowText(row, 'content_hash'),
        ].join(':')).join('\n'))
        .digest('hex');
    }

    const orderedOldSequences = [...oldToActual.keys()].sort(
      (left, right) => left - right,
    );
    for (const checkpoint of state.reflectionCheckpoints) {
      const lastTurnId = optionalRowText(checkpoint, 'last_turn_id');
      if (lastTurnId && actualByTurn.has(lastTurnId)) {
        checkpoint.last_ingest_seq = actualByTurn.get(lastTurnId)!;
        continue;
      }
      const oldSequence = Number(checkpoint.last_ingest_seq || 0);
      if (oldSequence === 0) {
        checkpoint.last_ingest_seq = 0;
        continue;
      }
      const nearest = orderedOldSequences
        .filter((sequence) => sequence <= oldSequence)
        .at(-1);
      checkpoint.last_ingest_seq = nearest === undefined
        ? 0
        : oldToActual.get(nearest)!;
    }
    let nextEventId = Number(
      (this.database.prepare(
        'SELECT COALESCE(MAX(id), 0) AS value FROM memory_reflection_events',
      ).get() as DatabaseRow | undefined)?.value || 0,
    );
    for (const event of [...state.reflectionEvents].sort(
      (left, right) => Number(left.id) - Number(right.id),
    )) {
      nextEventId += 1;
      event.id = nextEventId;
    }
  }

  private insertBackupRows(
    table: keyof {
      conversation_sessions: true;
      conversation_turns: true;
      extraction_runs: true;
      memory_candidates: true;
      memory_action_requests: true;
      candidate_resolution_runs: true;
      memory_items: true;
      memory_versions: true;
      memory_evidence: true;
      memory_edges: true;
      memory_events: true;
      outbox_events: true;
      memory_jobs: true;
      dead_letter_jobs: true;
      retention_policies: true;
      memory_tombstones: true;
      derived_consolidations: true;
      derived_consolidation_sources: true;
      derived_consolidation_sentences: true;
      derived_sentence_sources: true;
      purge_jobs: true;
      namespace_quality_snapshots: true;
      namespace_rollout_state: true;
      namespace_recall_shadow_comparisons: true;
      memory_reflection_settings: true;
      memory_reflection_checkpoints: true;
      memory_reflection_runs: true;
      memory_reflection_run_turns: true;
      memory_reflection_model_calls: true;
      memory_reflection_claims: true;
      memory_reflection_events: true;
      memory_candidate_evidence: true;
      conversation_episodes: true;
      conversation_episode_turns: true;
      memory_pattern_observations: true;
      conversation_memory_summaries: true;
      conversation_memory_summary_sources: true;
    },
    rows: Array<Record<string, string | number | null>>,
  ): void {
    if (rows.length === 0) return;
    const columns = (
      this.database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as DatabaseRow[]
    ).map((row) => asString(row.name));
    if (columns.length === 0) {
      throw new Error(`完整备份目标表不存在：${table}`);
    }
    const insert = this.database.prepare(
      `INSERT INTO ${table} (
         ${columns.join(', ')}
       ) VALUES (
         ${columns.map(() => '?').join(', ')}
       )`,
    );
    for (const row of rows) {
      insert.run(
        ...columns.map(
          (column) =>
            column in row
              ? row[column] as SQLInputValue
              : this.backupColumnDefault(table, column, row),
        ),
      );
    }
  }

  private restoreImportedConversationSessionRollups(
    sessions: Array<Record<string, string | number | null>>,
  ): void {
    const targetColumns = new Set(
      (
        this.database
          .prepare('PRAGMA table_info(conversation_sessions)')
          .all() as DatabaseRow[]
      ).map((row) => asString(row.name)),
    );
    const rollupColumns = [
      'message_count',
      'last_message_at',
      'last_message_preview',
      'updated_at',
      'version',
    ].filter((column) => targetColumns.has(column));
    for (const session of sessions) {
      const columns = rollupColumns.filter(
        (column) => Object.hasOwn(session, column),
      );
      if (columns.length === 0) continue;
      this.database
        .prepare(
          `UPDATE conversation_sessions
           SET ${columns.map((column) => `${column} = ?`).join(', ')}
           WHERE id = ?`,
        )
        .run(
          ...columns.map((column) => session[column] as SQLInputValue),
          session.id as SQLInputValue,
        );
    }
  }

  private backupColumnDefault(
    table: string,
    column: string,
    row: Record<string, string | number | null>,
  ): SQLInputValue {
    const defaults: Record<string, Record<string, SQLInputValue>> = {
      conversation_sessions: {
        persona_id: null,
        project_id: null,
        identity_source: 'legacy',
        identity_status: 'legacy',
      },
      conversation_turns: {
        round_id: null,
      },
      extraction_runs: {
        extractor_id: 'memory-extractor',
        extractor_version: 'v1',
        prompt_contract_version: row.prompt_version || 'unknown',
      },
      memory_candidates: {
        negated: 0,
        scope_type: 'personal',
        scope_key: 'self',
        claim_occurred_at: null,
        claim_valid_from: null,
        claim_valid_to: null,
        source_excerpt: null,
        source_authority: 'legacy_unknown',
        extractor_id: 'legacy',
        extractor_version: 'v1',
        extraction_model: 'unknown',
        extraction_prompt_version: 'unknown',
        reflection_run_id: null,
        candidate_origin: 'turn_extraction',
        claim_fingerprint: null,
      },
      memory_items: {
        scope_type: 'personal',
        scope_key: 'self',
        sensitivity: 'normal',
        source_authority: 'legacy_unknown',
      },
      memory_versions: {
        scope_type: 'personal',
        scope_key: 'self',
        sensitivity: 'normal',
        source_authority: 'legacy_unknown',
        negated: 0,
      },
      memory_evidence: {
        sensitivity: 'normal',
        source_authority: 'legacy_unknown',
      },
      memory_tombstones: {
        scope_type: 'personal',
        scope_key: 'self',
      },
      memory_jobs: {
        required_model_id: null,
        required_generation_id: null,
      },
    };
    if (table === 'memory_candidates' && column === 'stable_key') {
      return [
        row.scope_type || 'personal',
        row.scope_key || 'self',
        row.normalized_key || '',
      ].join('::');
    }
    const value = defaults[table]?.[column];
    if (value !== undefined) return value;
    throw new Error(
      `完整备份的 ${table} 缺少字段 ${column}`,
    );
  }

  private enqueueDenseRebuildJobs(ownerId: string): void {
    if (!this.semanticRanker) return;
    const namespaces = this.database
      .prepare(
        `SELECT DISTINCT namespace
         FROM memories
         WHERE user_id = ? AND status = 'active'
         ORDER BY namespace ASC`,
      )
      .all(ownerId) as DatabaseRow[];
    const timestamp = now();
    const insert = this.database.prepare(
      `INSERT INTO memory_jobs (
         id, job_type, user_id, namespace, payload_json, priority,
         max_attempts, available_at, created_at, updated_at,
         required_model_id, required_generation_id
       ) VALUES (
         ?, 'backfill_dense_index', ?, ?, ?, 2, 5, ?, ?, ?, ?, ?
       )`,
    );
    for (const row of namespaces) {
      const namespace = asString(row.namespace);
      const generations =
        this.retrievalIndex.denseGenerationsForScope(
          ownerId,
          namespace,
        );
      const targets = generations.length > 0
        ? generations
        : [null];
      for (const generation of targets) {
        const model = generation?.embeddingModel ||
          this.semanticRanker.embeddingModel;
        insert.run(
          [
            'backfill-dense',
            model,
            ownerId,
            namespace,
            generation?.generationId ||
              `restore-${randomUUID()}`,
          ].join(':'),
          ownerId,
          namespace,
          JSON.stringify({
            model,
            indexVersion:
              generation?.indexVersion || DENSE_LSH_VERSION,
            probeModel: true,
            ...(generation
              ? {
                  dimensions: generation.dimensions,
                  generationKey: generation.generationKey,
                  generationId: generation.generationId,
                }
              : {}),
          }),
          timestamp,
          timestamp,
          timestamp,
          generation?.modelId || null,
          generation?.generationId || null,
        );
      }
    }
  }

  private indexedRecallCandidates(
    input: RecallInput,
    ownerId: string,
    timestamp: string,
    dense?: {
      vector: Float32Array;
      model: string;
      generationKey: string;
      generationId: string;
    },
  ): IndexedRecallSearch {
    const retrieval = this.retrievalIndex.searchWithDiagnostics({
      query: input.query,
      userId: ownerId,
      namespace: input.namespace,
      kinds: input.kinds,
      tags: cleanTags(input.tags),
      includeArchived: input.includeArchived,
      scopes: input.scopes,
      scopeType: input.scopeType,
      scopeKey: input.scopeKey,
      clearance: input.clearance,
      allowedSensitivities: input.allowedSensitivities,
      limit: config.maxRecallCandidates,
      timestamp,
      denseVector: dense?.vector,
      denseModel: dense?.model,
      denseGenerationKey: dense?.generationKey,
      denseGenerationId: dense?.generationId,
    });
    return {
      candidates: this.hydrateIndexedRecallCandidates(
        retrieval.candidates,
        input.query,
      ),
      diagnostics: retrieval.diagnostics,
    };
  }

  private hydrateIndexedRecallCandidates(
    retrieval: HybridCandidate[],
    queryVariant: string,
  ): IndexedRecallCandidate[] {
    if (retrieval.length === 0) return [];
    const rows = this.database
      .prepare(
        `SELECT *
         FROM memories
         WHERE id IN (${retrieval.map(() => '?').join(', ')})`,
      )
      .all(...retrieval.map((candidate) => candidate.id)) as
      DatabaseRow[];
    const rowById = new Map(
      rows.map((row) => [asString(row.id), row]),
    );
    return retrieval.flatMap((candidate) => {
      const row = rowById.get(candidate.id);
      if (!row) return [];
      return [{
        memory: rowToMemory(row),
        semanticRevision: Math.max(
          1,
          Number(row.semantic_revision) || 1,
        ),
        retrieval: candidate,
        rawEmbedding: row.embedding,
        queryVariantHits: [queryVariant],
      }];
    });
  }

  private mergeIndexedRecallCandidates(
    groups: IndexedRecallCandidate[][],
  ): IndexedRecallCandidate[] {
    const merged = new Map<string, IndexedRecallCandidate>();
    const minimumRank = (
      left: number | null,
      right: number | null,
    ): number | null => {
      if (left === null) return right;
      if (right === null) return left;
      return Math.min(left, right);
    };
    for (const group of groups) {
      for (const candidate of group) {
        const existing = merged.get(candidate.memory.id);
        if (!existing) {
          merged.set(candidate.memory.id, {
            ...candidate,
            retrieval: { ...candidate.retrieval },
            queryVariantHits: [...candidate.queryVariantHits],
          });
          continue;
        }
        existing.retrieval.fusedScore +=
          candidate.retrieval.fusedScore;
        existing.retrieval.lexicalRank = minimumRank(
          existing.retrieval.lexicalRank,
          candidate.retrieval.lexicalRank,
        );
        existing.retrieval.annRank = minimumRank(
          existing.retrieval.annRank,
          candidate.retrieval.annRank,
        );
        existing.retrieval.termRank = minimumRank(
          existing.retrieval.termRank,
          candidate.retrieval.termRank,
        );
        existing.retrieval.graphRank = minimumRank(
          existing.retrieval.graphRank,
          candidate.retrieval.graphRank,
        );
        existing.retrieval.annHits = Math.max(
          existing.retrieval.annHits,
          candidate.retrieval.annHits,
        );
        existing.retrieval.termHits = Math.max(
          existing.retrieval.termHits,
          candidate.retrieval.termHits,
        );
        existing.queryVariantHits = [...new Set([
          ...existing.queryVariantHits,
          ...candidate.queryVariantHits,
        ])];
      }
    }
    return [...merged.values()]
      .sort((left, right) =>
        right.retrieval.fusedScore - left.retrieval.fusedScore ||
        left.memory.id.localeCompare(right.memory.id),
      )
      .slice(0, config.maxRecallCandidates);
  }

  private feedbackPriors(memoryIds: string[]): Map<string, number> {
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0 || config.feedbackPriorMax === 0) {
      return new Map();
    }
    const rows = this.database
      .prepare(
        `SELECT id, used_count, confirmed_count, rejected_count
         FROM memory_items
         WHERE id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids) as DatabaseRow[];
    return new Map(rows.map((row) => {
      const positive =
        Math.max(0, Number(row.used_count) || 0) +
        Math.max(0, Number(row.confirmed_count) || 0) * 2;
      const negative =
        Math.max(0, Number(row.rejected_count) || 0) * 2;
      const signal = (positive - negative) /
        (positive + negative + 5);
      const prior = Math.max(
        -config.feedbackPriorMax,
        Math.min(config.feedbackPriorMax, signal * config.feedbackPriorMax),
      );
      return [
        asString(row.id),
        Number(prior.toFixed(6)),
      ];
    }));
  }

  private async probeSemanticRanker(
    ranker: SemanticRanker,
    force: boolean,
  ): Promise<{ dimensions: number; generationKey: string }> {
    const cached = this.rankerProbes.get(ranker);
    if (cached && !force) return cached;
    const probe = await ranker.embed([DENSE_GENERATION_PROBE]);
    if (probe.length !== 1 || probe[0].length === 0) {
      throw new Error('dense backfill 无法探测 embedding 维度');
    }
    const result = {
      dimensions: probe[0].length,
      generationKey: denseGenerationKey(probe[0]),
    };
    this.rankerProbes.set(ranker, result);
    return result;
  }

  private registerRankerGeneration(
    ranker: SemanticRanker,
    probe: { dimensions: number; generationKey: string },
    userId: string,
    namespace: string,
  ): DenseGenerationRegistration {
    const registration =
      this.retrievalIndex.registerDenseGeneration({
        userId: cleanUserId(userId),
        namespace: cleanText(
          namespace,
          config.defaultNamespace,
        ),
        embeddingModel: ranker.embeddingModel,
        dimensions: probe.dimensions,
        generationKey: probe.generationKey,
        timestamp: now(),
      });
    this.generationRankers.set(
      registration.generation.generationId,
      ranker,
    );
    return registration;
  }

  private async rankerForGeneration(
    generation: DenseIndexGeneration,
    forceProbe: boolean,
  ): Promise<SemanticRanker> {
    const cached = this.generationRankers.get(
      generation.generationId,
    );
    if (cached) {
      const probe = await this.probeSemanticRanker(
        cached,
        forceProbe,
      );
      if (
        probe.dimensions === generation.dimensions &&
        probe.generationKey === generation.generationKey
      ) {
        return cached;
      }
      this.generationRankers.delete(generation.generationId);
    }
    for (const ranker of this.semanticRankers) {
      if (ranker.embeddingModel !== generation.embeddingModel) {
        continue;
      }
      const probe = await this.probeSemanticRanker(
        ranker,
        forceProbe,
      );
      if (
        probe.dimensions === generation.dimensions &&
        probe.generationKey === generation.generationKey
      ) {
        this.generationRankers.set(
          generation.generationId,
          ranker,
        );
        return ranker;
      }
    }
    throw new Error(
      `Dense generation ${generation.generationId} 没有匹配的 embedding provider`,
    );
  }

  private async embedAndIndexMemories(
    memories: DenseIndexMemory[],
    generation: DenseIndexGeneration,
    ranker: SemanticRanker,
    beforeCommit?: () => void,
  ): Promise<{
    indexed: number;
    embeddingDurationMs: number;
    databaseWriteDurationMs: number;
    embeddingBatchCalls: number;
  }> {
    if (memories.length === 0) {
      return {
        indexed: 0,
        embeddingDurationMs: 0,
        databaseWriteDurationMs: 0,
        embeddingBatchCalls: 0,
      };
    }
    const model = generation.embeddingModel;
    const expectedDimensions = generation.dimensions;
    const expectedGenerationKey = generation.generationKey;
    const ids = memories.map(({ memory }) => memory.id);
    const cachedRows = this.database
      .prepare(
        `SELECT memory_id, text_hash, dimensions, generation_key,
                memory_revision, embedding
         FROM memory_embeddings
         WHERE generation_id = ?
           AND memory_id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(generation.generationId, ...ids) as DatabaseRow[];
    const cached = new Map(
      cachedRows.map((row) => [asString(row.memory_id), row]),
    );
    const vectors = new Map<string, Float32Array>();
    const missing: Array<{
      memory: MemoryRecord;
      semanticRevision: number;
      text: string;
      textHash: string;
    }> = [];
    for (const indexedMemory of memories) {
      const { memory, semanticRevision } = indexedMemory;
      const text = semanticMemoryText(memory);
      const textHash = semanticTextHash(text);
      const row = cached.get(memory.id);
      if (
        row &&
        asString(row.text_hash) === textHash &&
        asString(row.generation_key) === expectedGenerationKey &&
        Number(row.memory_revision) === semanticRevision &&
        row.embedding instanceof Uint8Array
      ) {
        const vector = bufferToVector(row.embedding);
        if (
          vector.length > 0 &&
          vector.length === Number(row.dimensions) &&
          vector.length === expectedDimensions
        ) {
          vectors.set(memory.id, vector);
          continue;
        }
      }
      missing.push({
        memory,
        semanticRevision,
        text,
        textHash,
      });
    }

    let embeddingDurationMs = 0;
    let embeddingBatchCalls = 0;
    if (missing.length > 0) {
      const embeddingStartedAt = performance.now();
      const embedded = await ranker.embed(
        missing.map(({ text }) => text),
      );
      embeddingDurationMs = Number(
        (performance.now() - embeddingStartedAt).toFixed(3),
      );
      embeddingBatchCalls = 1;
      if (
        embedded.length !== missing.length ||
        embedded.some(
          (vector) => vector.length !== expectedDimensions,
        )
      ) {
        throw new Error('dense backfill 返回的向量数量不正确');
      }
      for (let index = 0; index < missing.length; index += 1) {
        const vector = embedded[index];
        vectors.set(missing[index].memory.id, vector);
      }
    }

    const upsertEmbedding = this.database.prepare(
      `INSERT INTO memory_embeddings (
         memory_id, generation_id, model, text_hash, dimensions,
         generation_key, memory_revision, embedding, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, generation_id) DO UPDATE SET
         model = excluded.model,
         text_hash = excluded.text_hash,
         dimensions = excluded.dimensions,
         generation_key = excluded.generation_key,
         memory_revision = excluded.memory_revision,
         embedding = excluded.embedding,
         updated_at = excluded.updated_at`,
    );
    let indexed = 0;
    const databaseWriteStartedAt = performance.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      beforeCommit?.();
      const currentRevisions = new Map(
        (
          this.database.prepare(
            `SELECT id, semantic_revision
             FROM memories
             WHERE id IN (${ids.map(() => '?').join(', ')})`,
          ).all(...ids) as DatabaseRow[]
        ).map((row) => [
          asString(row.id),
          Number(row.semantic_revision),
        ]),
      );
      const denseEntries = [];
      for (const indexedMemory of memories) {
        const { memory, semanticRevision } = indexedMemory;
        if (
          currentRevisions.get(memory.id) !== semanticRevision
        ) {
          continue;
        }
        const text = semanticMemoryText(memory);
        const textHash = semanticTextHash(text);
        const vector = vectors.get(memory.id);
        if (!vector) {
          throw new Error(`记忆 ${memory.id} 缺少 dense embedding`);
        }
        upsertEmbedding.run(
          memory.id,
          generation.generationId,
          model,
          textHash,
          vector.length,
          expectedGenerationKey,
          semanticRevision,
          vectorToBuffer(vector),
          memory.updatedAt,
        );
        denseEntries.push({
          memoryId: memory.id,
          generationId: generation.generationId,
          embeddingModel: model,
          textHash,
          vector,
          updatedAt: memory.updatedAt,
          memoryRevision: semanticRevision,
          generationKey: expectedGenerationKey,
        });
      }
      this.retrievalIndex.upsertDenseBatch(denseEntries);
      indexed = denseEntries.length;
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return {
      indexed,
      embeddingDurationMs,
      databaseWriteDurationMs: Number(
        (performance.now() - databaseWriteStartedAt).toFixed(3),
      ),
      embeddingBatchCalls,
    };
  }

  private indexMemory(memory: MemoryRecord): void {
    this.retrievalIndex.upsert(
      memory.id,
      semanticMemoryText(memory),
      memory.updatedAt,
    );
  }

  private audit(
    action: string,
    memoryId: string | null,
    userId: string,
    detail: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        `INSERT INTO audit_log
          (id, action, memory_id, user_id, detail_json, created_at)
         SELECT COALESCE(MAX(id), 0) + 1, ?, ?, ?, ?, ?
         FROM audit_log
         WHERE user_id = ?`,
      )
      .run(
        action,
        memoryId,
        userId,
        JSON.stringify(sanitizeAuditDetail(detail)),
        now(),
        userId,
      );
  }
}
