import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  bufferToVector,
  cosineSimilarity,
  retrievalTokens,
} from './embedding.js';
import type {
  MemoryAccessScope,
  MemoryClassification,
  MemoryKind,
  MemoryScopeType,
  MemorySensitivity,
} from './types.js';
import { classificationsVisibleAt } from './types.js';
import { withSqliteBusyRetry } from './sqlite-retry.js';

const ANN_INDEX_MODEL = 'local-hybrid-v2';
const ANN_BANDS = 16;
const STARTUP_INDEX_REPAIR_BATCH_SIZE = 256;
export const DENSE_LSH_VERSION = 'dense-sign-lsh-v1';
export const DENSE_LSH_BANDS = 32;
const DENSE_LSH_BITS = 8;
const DENSE_LSH_SAMPLES_PER_BIT = 4;
const DENSE_EXACT_FALLBACK_MAX_CANDIDATES = 256;

export interface HybridSearchInput {
  query: string;
  userId: string;
  namespace?: string;
  kinds?: MemoryKind[];
  tags?: string[];
  includeArchived?: boolean;
  scopes?: MemoryAccessScope[];
  scopeType?: MemoryScopeType;
  scopeKey?: string;
  /** 读者密级：共享作用域（project/role/public）内密级 ≤ clearance 的文档可见。 */
  clearance?: MemoryClassification;
  allowedSensitivities?: MemorySensitivity[];
  limit?: number;
  timestamp: string;
  denseVector?: Float32Array;
  denseModel?: string;
  denseGenerationKey?: string;
  denseGenerationId?: string;
}

export type DenseGenerationStatus =
  | 'building'
  | 'ready'
  | 'active'
  | 'retired'
  | 'failed';

export interface DenseIndexGeneration {
  generationId: string;
  modelId: string;
  embeddingModel: string;
  indexVersion: string;
  dimensions: number;
  generationKey: string;
  status: DenseGenerationStatus;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  failureReason: string | null;
}

export interface DenseIndexAlias {
  userId: string;
  namespace: string;
  activeGenerationId: string | null;
  buildingGenerationId: string | null;
  previousGenerationId: string | null;
  revision: number;
  updatedAt: string;
}

export interface DenseGenerationRegistration {
  generation: DenseIndexGeneration;
  alias: DenseIndexAlias;
  role: 'active' | 'building' | 'previous';
}

export interface HybridCandidate {
  id: string;
  fusedScore: number;
  lexicalRank: number | null;
  annRank: number | null;
  annHits: number;
  termRank: number | null;
  termHits: number;
  graphRank: number | null;
}

export interface HybridCandidateCounts {
  rawCount: number;
  returnedCount: number;
  cappedCount: number;
  strategy?: 'approximate' | 'exact_fallback';
  scannedCount?: number;
}

export interface HybridSearchDiagnostics {
  limit: number;
  perChannelLimit: number;
  annMode: 'dense_lsh' | 'minhash_ann';
  channels: {
    lexical: HybridCandidateCounts;
    ann: HybridCandidateCounts;
    term: HybridCandidateCounts;
  };
  fusion: HybridCandidateCounts & {
    validCount: number;
    invalidDerivedSourceCount: number;
  };
}

export interface HybridSearchResult {
  candidates: HybridCandidate[];
  diagnostics: HybridSearchDiagnostics;
}

export interface HybridGraphSearchResult {
  candidates: HybridCandidate[];
  diagnostics: HybridCandidateCounts;
}

export interface DenseChannelSearchResult {
  candidates: Array<{ id: string; hits: number }>;
  diagnostics: HybridCandidateCounts;
}

interface HybridChannelResult<T> {
  rows: T[];
  counts: HybridCandidateCounts;
}

interface PreparedLexicalIndexRepair {
  memoryId: string;
  updatedAt: string;
  buckets: string[];
  terms: string[];
}

export interface DenseIndexEntry {
  memoryId: string;
  generationId: string;
  embeddingModel: string;
  textHash: string;
  vector: Float32Array;
  updatedAt: string;
  memoryRevision: number;
  generationKey: string;
}

type DatabaseRow = Record<string, unknown>;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableText(value: unknown): string | null {
  return value === null || value === undefined
    ? null
    : asText(value);
}

function emptyCandidateCounts(): HybridCandidateCounts {
  return { rawCount: 0, returnedCount: 0, cappedCount: 0 };
}

function channelResult<T>(
  rows: DatabaseRow[],
  map: (row: DatabaseRow) => T,
  exactRawCount?: number,
): HybridChannelResult<T> {
  const rawCount = exactRawCount === undefined
    ? rows.length > 0
      ? Math.max(0, Number(rows[0].raw_count) || 0)
      : 0
    : Math.max(0, exactRawCount);
  return {
    rows: rows.map(map),
    counts: {
      rawCount,
      returnedCount: rows.length,
      cappedCount: Math.max(rawCount - rows.length, 0),
    },
  };
}

function stableIdentifier(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`;
}

export function deriveDenseGenerationIdentity(input: {
  embeddingModel: string;
  dimensions: number;
  generationKey: string;
}): { modelId: string; generationId: string } {
  const modelId = stableIdentifier(
    'embedding-model',
    [
      'semantic-ranker',
      input.embeddingModel,
      input.generationKey,
    ].join('\0'),
  );
  const generationId = stableIdentifier(
    'dense-generation',
    [
      modelId,
      DENSE_LSH_VERSION,
      input.dimensions,
      input.generationKey,
    ].join('\0'),
  );
  return { modelId, generationId };
}

function rowToDenseGeneration(
  row: DatabaseRow,
): DenseIndexGeneration {
  return {
    generationId: asText(row.generation_id),
    modelId: asText(row.model_id),
    embeddingModel: asText(row.embedding_model),
    indexVersion: asText(row.index_version),
    dimensions: Number(row.dimensions),
    generationKey: asText(row.generation_key),
    status: asText(row.status) as DenseGenerationStatus,
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
    readyAt: asNullableText(row.ready_at),
    failureReason: asNullableText(row.failure_reason),
  };
}

function rowToDenseAlias(row: DatabaseRow): DenseIndexAlias {
  return {
    userId: asText(row.user_id),
    namespace: asText(row.namespace),
    activeGenerationId: asNullableText(row.active_generation_id),
    buildingGenerationId: asNullableText(
      row.building_generation_id,
    ),
    previousGenerationId: asNullableText(
      row.previous_generation_id,
    ),
    revision: Math.max(1, Number(row.revision) || 1),
    updatedAt: asText(row.updated_at),
  };
}

function fnv1a(value: string, seed: number): number {
  let hash = (2_166_136_261 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function minHashBuckets(text: string): string[] {
  const tokens = retrievalTokens(text);
  if (tokens.length === 0) return [];
  const buckets: string[] = [];
  for (let band = 0; band < ANN_BANDS; band += 1) {
    let minimum = 0xffff_ffff;
    const seed = Math.imul(band + 1, 0x9e37_79b1);
    for (const token of tokens) {
      minimum = Math.min(minimum, fnv1a(token, seed));
    }
    buckets.push(minimum.toString(16).padStart(8, '0'));
  }
  return buckets;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb_352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846c_a68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

export function denseLshBuckets(vector: Float32Array): string[] {
  if (vector.length === 0) return [];
  const buckets: string[] = [];
  for (let band = 0; band < DENSE_LSH_BANDS; band += 1) {
    let bucket = 0;
    for (let bit = 0; bit < DENSE_LSH_BITS; bit += 1) {
      let projection = 0;
      for (
        let sample = 0;
        sample < DENSE_LSH_SAMPLES_PER_BIT;
        sample += 1
      ) {
        const seed = mix32(
          Math.imul(band + 1, 0x9e37_79b1) ^
            Math.imul(bit + 1, 0x85eb_ca6b) ^
            Math.imul(sample + 1, 0xc2b2_ae35),
        );
        const index = seed % vector.length;
        const sign = mix32(seed ^ 0x27d4_eb2d) & 1 ? 1 : -1;
        projection += vector[index] * sign;
      }
      if (projection >= 0) bucket |= 1 << bit;
    }
    buckets.push(bucket.toString(16).padStart(2, '0'));
  }
  return buckets;
}

function indexedTerms(text: string): string[] {
  return retrievalTokens(text)
    .filter(
      (term) =>
        term.startsWith('concept:') ||
        [...term].length >= 2,
    )
    .slice(0, 96);
}

// 词法查询计划：FTS5 表用 tokenize='trigram'，而 trigram 只能匹配长度 ≥3 的
// 短语。于是"差旅/补贴/AI"这类短查询在旧实现下拿不到任何 FTS 词，整条词法通道
// 静默空转（实测 8 条中文查询里 7 条词法命中为 0）。这里改为按词切分：
//   · 长度 ≥3 的词 → FTS 短语（享受 bm25 排序）
//   · 两字中文词 / 两字母缩写 → 子串匹配（trigram 索引做不到，必须走 LIKE）
// 单字中文（"的/是/多少"）在长查询里是噪声，仅在整条查询无可匹配词时兜底。
interface LexicalQueryPlan {
  match: string | null;
  substrings: string[];
}

const LEXICAL_MATCH_TERM_CAP = 48;
const LEXICAL_SUBSTRING_CAP = 8;
const WORD_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const HAN_PATTERN = /\p{Script=Han}/u;
const ALNUM_PATTERN = /[\p{Script=Latin}\p{N}]/u;

export function lexicalQueryPlan(query: string): LexicalQueryPlan {
  const normalized = query
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN');
  const words = [...WORD_SEGMENTER.segment(normalized)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((word) => word.length > 0);
  const matchTerms = new Set<string>();
  const substrings = new Set<string>();
  for (const word of words) {
    const length = [...word].length;
    if (length >= 3) {
      matchTerms.add(word);
      continue;
    }
    if (HAN_PATTERN.test(word) ? length === 2 : ALNUM_PATTERN.test(word)) {
      substrings.add(word);
    }
  }
  if (matchTerms.size === 0 && substrings.size === 0) {
    const compact = normalized.replace(/[^\p{Script=Han}\p{N}]/gu, '');
    if (compact) substrings.add([...compact].slice(0, 2).join(''));
  }
  const terms = [...matchTerms].slice(0, LEXICAL_MATCH_TERM_CAP);
  return {
    match: terms.length
      ? terms
          .map((term) => `"${term.replaceAll('"', '""')}"`)
          .join(' OR ')
      : null,
    substrings: [...substrings].slice(0, LEXICAL_SUBSTRING_CAP),
  };
}

function episodeBlockedByActiveTombstoneSql(
  memoryAlias: string,
  episodeAlias: string,
): string {
  return `EXISTS (
    SELECT 1
    FROM memory_tombstones active_tombstone
    JOIN memory_versions forgotten_version
      ON forgotten_version.memory_item_id =
         active_tombstone.memory_item_id
    JOIN memory_evidence forgotten_evidence
      ON forgotten_evidence.memory_version_id = forgotten_version.id
    JOIN conversation_episode_turns blocked_episode_turn
      ON blocked_episode_turn.turn_id = forgotten_evidence.turn_id
    WHERE active_tombstone.restored_at IS NULL
      AND active_tombstone.user_id = ${memoryAlias}.user_id
      AND active_tombstone.namespace = ${memoryAlias}.namespace
      AND blocked_episode_turn.episode_id = ${episodeAlias}.id
  )`;
}

function episodeBlockedBySupersededEvidenceSql(
  memoryAlias: string,
  episodeAlias: string,
): string {
  return `EXISTS (
    SELECT 1
    FROM conversation_episode_turns blocked_episode_turn
    JOIN memory_evidence version_evidence
      ON version_evidence.turn_id = blocked_episode_turn.turn_id
    JOIN memory_versions evidence_version
      ON evidence_version.id = version_evidence.memory_version_id
    JOIN memory_items evidence_item
      ON evidence_item.id = evidence_version.memory_item_id
    WHERE blocked_episode_turn.episode_id = ${episodeAlias}.id
      AND evidence_item.user_id = ${memoryAlias}.user_id
      AND evidence_item.namespace = ${memoryAlias}.namespace
      AND evidence_item.status = 'active'
      AND evidence_item.current_version_id IS NOT NULL
      AND (
        evidence_version.id != evidence_item.current_version_id
        OR evidence_version.superseded_at IS NOT NULL
        OR (
          evidence_version.id = evidence_item.current_version_id
          AND EXISTS (
            SELECT 1
            FROM memory_versions superseded_predecessor
            WHERE superseded_predecessor.memory_item_id = evidence_item.id
              AND superseded_predecessor.id !=
                  evidence_item.current_version_id
              AND superseded_predecessor.superseded_at IS NOT NULL
          )
        )
      )
  )`;
}

function validDerivedSourceSql(alias: string): string {
  return `(
    (
      ${alias}.source != 'consolidation'
      OR EXISTS (
      SELECT 1
      FROM derived_consolidations derived
      WHERE derived.memory_id = ${alias}.id
        AND derived.status = 'active'
        AND EXISTS (
          SELECT 1
          FROM derived_consolidation_sources source_exists
          WHERE source_exists.consolidation_id = derived.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM derived_consolidation_sentences sentence
          WHERE sentence.consolidation_id = derived.id
            AND sentence.supported = 0
        )
        AND NOT EXISTS (
          SELECT 1
          FROM derived_consolidation_sources source
          JOIN memory_versions source_version
            ON source_version.id = source.memory_version_id
          JOIN memory_items source_item
            ON source_item.id = source_version.memory_item_id
          JOIN memories source_memory
            ON source_memory.id = source_item.id
          WHERE source.consolidation_id = derived.id
            AND (
              source_memory.status != 'active'
              OR source_item.status != 'active'
              OR source_item.current_version_id != source_version.id
              OR source_version.superseded_at IS NOT NULL
            )
        )
      )
    )
    AND (
      ${alias}.source != 'conversation_episode'
      OR EXISTS (
        SELECT 1
        FROM conversation_episodes episode
        WHERE episode.memory_id = ${alias}.id
          AND episode.user_id = ${alias}.user_id
          AND episode.namespace = ${alias}.namespace
          AND episode.status = 'active'
          AND NOT ${episodeBlockedByActiveTombstoneSql(alias, 'episode')}
          AND NOT ${episodeBlockedBySupersededEvidenceSql(alias, 'episode')}
      )
    )
    AND (
      ${alias}.source != 'hierarchical_summary'
      OR EXISTS (
        SELECT 1
        FROM conversation_memory_summaries summary
        WHERE summary.memory_id = ${alias}.id
          AND summary.user_id = ${alias}.user_id
          AND summary.namespace = ${alias}.namespace
          AND summary.status = 'active'
          AND summary.source_count > 0
          AND summary.source_count = (
            SELECT COUNT(*)
            FROM conversation_memory_summary_sources source_count
            WHERE source_count.summary_id = summary.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM conversation_memory_summary_sources blocked_source
            JOIN conversation_episodes source_episode
              ON source_episode.id = blocked_source.episode_id
            WHERE blocked_source.summary_id = summary.id
              AND (
                source_episode.user_id != ${alias}.user_id
                OR source_episode.namespace != ${alias}.namespace
                OR source_episode.status != 'active'
                OR ${episodeBlockedByActiveTombstoneSql(
                  alias,
                  'source_episode',
                )}
                OR ${episodeBlockedBySupersededEvidenceSql(
                  alias,
                  'source_episode',
                )}
              )
          )
      )
    )
  )`;
}

interface AccessScopeInput {
  scopes?: MemoryAccessScope[];
  scopeType?: MemoryScopeType;
  scopeKey?: string;
}

const MEMORY_SCOPE_TYPES = new Set<MemoryScopeType>([
  'personal',
  'project',
  'role',
  'session',
  'public',
]);

/** user_id 绑定作用域：仅本人可见（可见性模型 v1 语义保留）。 */
function isOwnerBoundScope(scope: MemoryAccessScope): boolean {
  return scope.scopeType === 'personal' || scope.scopeType === 'session';
}

/**
 * 可见性模型 v2（多租户）：
 * - personal/session：仍按 user_id 私有（v1 语义，兼容聊天记忆）；
 * - project/role/public：可见性只由 scope 决定，写入方 user_id 退化为
 *   审计字段——这是"统一账号录入、各部门查看"的钥匙；
 * - 共享作用域叠加密级过滤：classification ≤ 读者 clearance
 *   （NULL 列为 NOT NULL DEFAULT 'internal'，不存在 NULL 分支）。
 */
function visibilitySql(
  alias: string,
  userId: string,
  scopes: MemoryAccessScope[],
  clearance?: MemoryClassification,
): { sql: string; values: SQLInputValue[] } {
  const ownerBound = scopes.filter(isOwnerBoundScope);
  const shared = scopes.filter((scope) => !isOwnerBoundScope(scope));
  const scopeClause = (scope: MemoryAccessScope) =>
    `(${alias}.scope_type = ? AND ${alias}.scope_key = ?)`;
  const branches: string[] = [];
  const values: SQLInputValue[] = [];
  if (ownerBound.length > 0) {
    branches.push(
      `(${alias}.user_id = ? AND (${ownerBound.map(scopeClause).join(' OR ')}))`,
    );
    values.push(
      userId,
      ...ownerBound.flatMap((scope) => [scope.scopeType, scope.scopeKey]),
    );
  }
  if (shared.length > 0) {
    const visible = classificationsVisibleAt(clearance ?? 'internal');
    branches.push(
      `((${shared.map(scopeClause).join(' OR ')}) AND ${
        alias
      }.classification IN (${visible.map(() => '?').join(', ')}))`,
    );
    values.push(
      ...shared.flatMap((scope) => [scope.scopeType, scope.scopeKey]),
      ...visible,
    );
  }
  if (branches.length === 0) {
    return { sql: '0 = 0', values: [] };
  }
  return { sql: `(${branches.join(' OR ')})`, values };
}

function normalizeAccessScope(
  scopeType: MemoryScopeType,
  scopeKey: string,
): MemoryAccessScope {
  if (!MEMORY_SCOPE_TYPES.has(scopeType)) {
    throw new Error('记忆作用域类型无效');
  }
  const normalizedKey =
    typeof scopeKey === 'string' ? scopeKey.trim() : '';
  if (!normalizedKey) {
    throw new Error('记忆作用域 scopeKey 不能为空');
  }
  return { scopeType, scopeKey: normalizedKey };
}

export function normalizeAccessScopes(
  input: AccessScopeInput,
): MemoryAccessScope[] {
  const hasScopes = input.scopes !== undefined;
  const hasLegacyScope =
    input.scopeType !== undefined || input.scopeKey !== undefined;
  let scopes: MemoryAccessScope[];
  if (hasScopes) {
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new Error('记忆作用域 scopes 不能为空');
    }
    const unique = new Map<string, MemoryAccessScope>();
    for (const scope of input.scopes) {
      if (!scope || typeof scope !== 'object') {
        throw new Error('记忆作用域无效');
      }
      const normalized = normalizeAccessScope(
        scope.scopeType,
        scope.scopeKey,
      );
      unique.set(
        `${normalized.scopeType}\u0000${normalized.scopeKey}`,
        normalized,
      );
    }
    scopes = [...unique.values()];
  } else {
    scopes = [normalizeAccessScope(
      input.scopeType || 'personal',
      input.scopeKey === undefined ? 'self' : input.scopeKey,
    )];
  }

  if (hasScopes && hasLegacyScope) {
    const legacy = normalizeAccessScope(
      input.scopeType || 'personal',
      input.scopeKey === undefined ? 'self' : input.scopeKey,
    );
    if (
      scopes.length !== 1 ||
      scopes[0].scopeType !== legacy.scopeType ||
      scopes[0].scopeKey !== legacy.scopeKey
    ) {
      throw new Error(
        'scopes 与旧 scopeType/scopeKey 作用域冲突，不能混用',
      );
    }
  }
  return scopes;
}

function scopeSql(
  alias: string,
  input: HybridSearchInput,
): { sql: string[]; values: SQLInputValue[] } {
  const sql = [
    // bi-temporal：当前事实恒可见；被取代（superseded）的历史事实仅在
    // as-of 时点早于其封口时间（updated_at）时可见——供"以前是什么"类回溯查询。
    input.includeArchived
      ? `(${alias}.status IN ('active', 'archived') OR (${alias}.status = 'superseded' AND ${alias}.updated_at > ?))`
      : `(${alias}.status = 'active' OR (${alias}.status = 'superseded' AND ${alias}.updated_at > ?))`,
    `(${alias}.valid_from IS NULL OR ${alias}.valid_from <= ?)`,
    `(${alias}.valid_to IS NULL OR ${alias}.valid_to > ?)`,
    `NOT EXISTS (
      SELECT 1
      FROM memory_items scope_item
      WHERE scope_item.id = ${alias}.id
        AND scope_item.expires_at IS NOT NULL
        AND scope_item.expires_at <= ?
    )`,
  ];
  const values: SQLInputValue[] = [
    input.timestamp,
    input.timestamp,
    input.timestamp,
    input.timestamp,
  ];
  const visibility = visibilitySql(
    alias,
    input.userId,
    normalizeAccessScopes(input),
    input.clearance,
  );
  sql.push(visibility.sql);
  values.push(...visibility.values);
  const allowedSensitivities = [
    ...new Set(
      (input.allowedSensitivities || ['normal']).filter(
        (value): value is Exclude<MemorySensitivity, 'credential'> =>
          value === 'normal' || value === 'sensitive',
      ),
    ),
  ];
  if (allowedSensitivities.length === 0) {
    sql.push('1 = 0');
  } else {
    sql.push(
      `${alias}.sensitivity IN (` +
      `${allowedSensitivities.map(() => '?').join(', ')})`,
    );
    values.push(...allowedSensitivities);
  }
  if (input.namespace) {
    sql.push(`${alias}.namespace = ?`);
    values.push(input.namespace);
  }
  if (input.kinds?.length) {
    sql.push(
      `${alias}.kind IN (${input.kinds.map(() => '?').join(', ')})`,
    );
    values.push(...input.kinds);
  }
  for (const tag of input.tags || []) {
    sql.push(`${alias}.tags_json LIKE ?`);
    values.push(`%${JSON.stringify(tag).slice(1, -1)}%`);
  }
  return { sql, values };
}

export class HybridRetrievalIndex {
  constructor(private readonly database: DatabaseSync) {}

  ensureIndexed(): number {
    const startedAt = Date.now();
    let cursor = '';
    let batches = 0;
    let totalRepaired = 0;
    let totalBusyRetries = 0;

    while (true) {
      const preparationStartedAt = Date.now();
      const rows = this.database
        .prepare(
          `SELECT m.id, m.title, m.content, m.summary, m.tags_json,
                  m.updated_at
           FROM memories m
           WHERE m.status != 'deleted'
             AND m.id > ?
             AND NOT EXISTS (
               SELECT 1
               FROM conversation_episode_compactions compacted_episode
               WHERE compacted_episode.memory_id = m.id
             )
             AND (
               (
                 SELECT COUNT(DISTINCT a.band)
                 FROM memory_ann_index a
                 WHERE a.memory_id = m.id
                   AND a.index_model = ?
               ) != ?
               OR NOT EXISTS (
                 SELECT 1
                 FROM memory_term_index t
                 WHERE t.memory_id = m.id
                   AND t.index_model = ?
               )
             )
           ORDER BY m.id ASC
           LIMIT ?`,
        )
        .all(
          cursor,
          ANN_INDEX_MODEL,
          ANN_BANDS,
          ANN_INDEX_MODEL,
          STARTUP_INDEX_REPAIR_BATCH_SIZE,
        ) as DatabaseRow[];
      if (rows.length === 0) break;
      cursor = asText(rows.at(-1)?.id);
      const prepared = rows.map((row): PreparedLexicalIndexRepair => {
        const text = [
          asText(row.title),
          asText(row.content),
          asText(row.summary),
          asText(row.tags_json),
        ].join('\n');
        return {
          memoryId: asText(row.id),
          updatedAt: asText(row.updated_at),
          buckets: minHashBuckets(text),
          terms: indexedTerms(text),
        };
      });
      const preparationDurationMs = Date.now() - preparationStartedAt;
      let batchBusyRetries = 0;
      withSqliteBusyRetry(
        () => this.database.exec('BEGIN IMMEDIATE'),
        {
          operation: 'acquire hybrid index repair write lock',
          maxAttempts: 8,
          totalBudgetMs: 15_000,
          onRetry: () => {
            batchBusyRetries += 1;
          },
        },
      );
      const lockStartedAt = Date.now();
      let repaired = 0;
      let skipped = 0;
      let unindexable = 0;
      try {
        for (const entry of prepared) {
          const current = this.database
            .prepare(
              `SELECT m.updated_at
               FROM memories m
               WHERE m.id = ? AND m.status != 'deleted'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM conversation_episode_compactions compacted_episode
                   WHERE compacted_episode.memory_id = m.id
                 )`,
            )
            .get(entry.memoryId);
          if (
            !current ||
            asText(current.updated_at) !== entry.updatedAt
          ) {
            skipped += 1;
            continue;
          }
          const annCount = Number(
            this.database
              .prepare(
                `SELECT COUNT(DISTINCT band) AS count
                 FROM memory_ann_index
                 WHERE memory_id = ? AND index_model = ?`,
              )
              .get(entry.memoryId, ANN_INDEX_MODEL)?.count ?? 0,
          );
          const termCount = Number(
            this.database
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM memory_term_index
                 WHERE memory_id = ? AND index_model = ?`,
              )
              .get(entry.memoryId, ANN_INDEX_MODEL)?.count ?? 0,
          );
          if (
            annCount === entry.buckets.length &&
            termCount === entry.terms.length
          ) {
            skipped += 1;
            continue;
          }
          if (entry.buckets.length === 0 && entry.terms.length === 0) {
            unindexable += 1;
          }
          this.upsertPrepared(entry);
          repaired += 1;
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      batches += 1;
      totalRepaired += repaired;
      totalBusyRetries += batchBusyRetries;
      console.error(JSON.stringify({
        component: 'hybrid-index-repair',
        event: 'batch-committed',
        batch: batches,
        selected: prepared.length,
        repaired,
        skipped,
        unindexable,
        busyRetries: batchBusyRetries,
        preparationDurationMs,
        lockDurationMs: Date.now() - lockStartedAt,
      }));
    }

    if (batches > 0) {
      console.error(JSON.stringify({
        component: 'hybrid-index-repair',
        event: 'completed',
        batches,
        repaired: totalRepaired,
        busyRetries: totalBusyRetries,
        totalDurationMs: Date.now() - startedAt,
      }));
    }
    return totalRepaired;
  }

  upsert(
    memoryId: string,
    text: string,
    updatedAt: string,
  ): void {
    this.upsertPrepared({
      memoryId,
      updatedAt,
      buckets: minHashBuckets(text),
      terms: indexedTerms(text),
    });
  }

  private upsertPrepared(entry: PreparedLexicalIndexRepair): void {
    this.removeLexical(entry.memoryId);
    const insert = this.database.prepare(
      `INSERT INTO memory_ann_index (
         memory_id, index_model, band, bucket, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [band, bucket] of entry.buckets.entries()) {
      insert.run(
        entry.memoryId,
        ANN_INDEX_MODEL,
        band,
        bucket,
        entry.updatedAt,
      );
    }
    const insertTerm = this.database.prepare(
      `INSERT INTO memory_term_index (
         memory_id, index_model, term, updated_at
       ) VALUES (?, ?, ?, ?)`,
    );
    for (const term of entry.terms) {
      insertTerm.run(
        entry.memoryId,
        ANN_INDEX_MODEL,
        term,
        entry.updatedAt,
      );
    }
  }

  remove(memoryId: string): void {
    this.removeLexical(memoryId);
    this.database
      .prepare('DELETE FROM memory_dense_lsh WHERE memory_id = ?')
      .run(memoryId);
  }

  upsertDense(
    memoryId: string,
    generationId: string,
    embeddingModel: string,
    textHash: string,
    vector: Float32Array,
    updatedAt: string,
    memoryRevision: number,
    generationKey: string,
  ): void {
    this.upsertDenseBatch([{
      memoryId,
      generationId,
      embeddingModel,
      textHash,
      vector,
      updatedAt,
      memoryRevision,
      generationKey,
    }]);
  }

  upsertDenseBatch(entries: DenseIndexEntry[]): void {
    if (entries.length === 0) return;
    const remove = this.database.prepare(
      `DELETE FROM memory_dense_lsh
       WHERE memory_id = ?
         AND generation_id = ?
         AND embedding_model = ?
         AND index_version = ?`,
    );
    const insert = this.database.prepare(
      `INSERT INTO memory_dense_lsh (
         memory_id, generation_id, embedding_model, index_version,
         band, bucket, text_hash, updated_at, dimensions,
         memory_revision, generation_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of entries) {
      const buckets = denseLshBuckets(entry.vector);
      if (buckets.length !== DENSE_LSH_BANDS) {
        throw new Error('dense embedding 不能为空');
      }
      remove.run(
        entry.memoryId,
        entry.generationId,
        entry.embeddingModel,
        DENSE_LSH_VERSION,
      );
      for (const [band, bucket] of buckets.entries()) {
        insert.run(
          entry.memoryId,
          entry.generationId,
          entry.embeddingModel,
          DENSE_LSH_VERSION,
          band,
          bucket,
          entry.textHash,
          entry.updatedAt,
          entry.vector.length,
          entry.memoryRevision,
          entry.generationKey,
        );
      }
    }
  }

  isDenseIndexed(
    memoryId: string,
    generationId: string,
    embeddingModel: string,
    textHash: string,
    updatedAt: string,
    dimensions: number,
    memoryRevision: number,
    generationKey: string,
  ): boolean {
    const row = this.database
      .prepare(
        `SELECT COUNT(DISTINCT band) AS count
         FROM memory_dense_lsh
         WHERE memory_id = ?
           AND generation_id = ?
           AND embedding_model = ?
           AND index_version = ?
           AND text_hash = ?
           AND updated_at = ?
           AND dimensions = ?
           AND memory_revision = ?
           AND generation_key = ?`,
      )
      .get(
        memoryId,
        generationId,
        embeddingModel,
        DENSE_LSH_VERSION,
        textHash,
        updatedAt,
        dimensions,
        memoryRevision,
        generationKey,
      );
    return Number(row?.count) === DENSE_LSH_BANDS;
  }

  denseWatermark(input: {
    userId: string;
    namespace?: string;
    generationId: string;
    embeddingModel: string;
    timestamp: string;
    dimensions?: number | null;
    generationKey?: string | null;
    includeArchived?: boolean;
    scopes?: MemoryAccessScope[];
    scopeType?: MemoryScopeType;
    scopeKey?: string;
    clearance?: MemoryClassification;
    allowedSensitivities?: MemorySensitivity[];
    verifyLshBands?: boolean;
    includeForeignGenerations?: boolean;
  }): {
    eligible: number;
    indexed: number;
    complete: boolean;
    foreignGenerations: string[];
  } {
    const filters = [
      input.includeArchived
        ? `m.status IN ('active', 'archived')`
        : `m.status = 'active'`,
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
      validDerivedSourceSql('m'),
    ];
    const values: SQLInputValue[] = [
      input.timestamp,
      input.timestamp,
      input.timestamp,
    ];
    if (input.namespace) {
      filters.push('m.namespace = ?');
      values.push(input.namespace);
    }
    if (
      input.scopes !== undefined ||
      input.scopeType !== undefined ||
      input.scopeKey !== undefined
    ) {
      const visibility = visibilitySql(
        'm',
        input.userId,
        normalizeAccessScopes(input),
        input.clearance,
      );
      filters.push(visibility.sql);
      values.push(...visibility.values);
    }
    if (input.allowedSensitivities) {
      const allowedSensitivities = [
        ...new Set(
          input.allowedSensitivities.filter(
            (
              value,
            ): value is Exclude<MemorySensitivity, 'credential'> =>
              value === 'normal' || value === 'sensitive',
          ),
        ),
      ];
      if (allowedSensitivities.length === 0) {
        filters.push('1 = 0');
      } else {
        filters.push(
          `m.sensitivity IN (` +
          `${allowedSensitivities.map(() => '?').join(', ')})`,
        );
        values.push(...allowedSensitivities);
      }
    }
    const eligible = Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memories m
           WHERE ${filters.join(' AND ')}`,
        )
        .get(...values)?.count || 0,
    );
    const embedded = Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memories m
           JOIN memory_embeddings e
             ON e.memory_id = m.id
            AND e.generation_id = ?
           WHERE ${filters.join(' AND ')}
             AND e.model = ?
             ${input.dimensions
               ? 'AND e.dimensions = ?'
               : 'AND e.dimensions IS NOT NULL'}
             ${input.generationKey
               ? 'AND e.generation_key = ?'
               : 'AND e.generation_key IS NOT NULL'}
             AND e.memory_revision = m.semantic_revision
             AND length(e.embedding) = e.dimensions * ?`,
        )
        .get(
          input.generationId,
          ...values,
          input.embeddingModel,
          ...(input.dimensions ? [input.dimensions] : []),
          ...(input.generationKey ? [input.generationKey] : []),
          Float32Array.BYTES_PER_ELEMENT,
        )?.count || 0,
    );
    let foreignGenerations: string[] = [];
    if (input.includeForeignGenerations && eligible > 0 && embedded === 0) {
      foreignGenerations = (
        this.database
          .prepare(
            `SELECT DISTINCT d.generation_id AS gid
             FROM memory_dense_lsh d
             JOIN memories m ON m.id = d.memory_id
             WHERE d.generation_id != ?
               AND ${filters.join(' AND ')}`,
          )
          .all(input.generationId, ...values) as DatabaseRow[]
      )
        .map((row) => asText(row.gid))
        .filter((value) => value.length > 0)
        .sort();
    }
    if (
      embedded !== eligible ||
      input.verifyLshBands === false
    ) {
      return {
        eligible,
        indexed: Math.min(eligible, embedded),
        complete: embedded === eligible,
        foreignGenerations,
      };
    }
    const indexed = Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM (
             SELECT m.id
             FROM memories m
             JOIN memory_dense_lsh d ON d.memory_id = m.id
             WHERE ${filters.join(' AND ')}
               AND d.embedding_model = ?
               AND d.index_version = ?
               AND d.generation_id = ?
               ${input.dimensions
                 ? 'AND d.dimensions = ?'
                 : 'AND d.dimensions IS NOT NULL'}
               ${input.generationKey
                 ? 'AND d.generation_key = ?'
                 : 'AND d.generation_key IS NOT NULL'}
               AND d.memory_revision = m.semantic_revision
             GROUP BY m.id
             HAVING COUNT(DISTINCT d.band) = ?
           )`,
        )
        .get(
          ...values,
          input.embeddingModel,
          DENSE_LSH_VERSION,
          input.generationId,
          ...(input.dimensions ? [input.dimensions] : []),
          ...(input.generationKey ? [input.generationKey] : []),
          DENSE_LSH_BANDS,
        )?.count || 0,
    );
    return {
      eligible,
      indexed,
      complete: indexed === eligible,
      foreignGenerations,
    };
  }

  registerDenseGeneration(input: {
    userId: string;
    namespace: string;
    embeddingModel: string;
    dimensions: number;
    generationKey: string;
    timestamp: string;
  }): DenseGenerationRegistration {
    if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
      throw new Error('dense embedding 维度无效');
    }
    const { modelId, generationId } = deriveDenseGenerationIdentity({
      embeddingModel: input.embeddingModel,
      dimensions: input.dimensions,
      generationKey: input.generationKey,
    });
    this.database.exec('SAVEPOINT register_dense_generation');
    try {
      this.database
        .prepare(
          `INSERT INTO embedding_model_registry (
             model_id, provider, model_name, created_at, metadata_json
           ) VALUES (?, 'semantic-ranker', ?, ?, '{}')
           ON CONFLICT(model_id) DO NOTHING`,
        )
        .run(modelId, input.embeddingModel, input.timestamp);
      this.database
        .prepare(
          `INSERT INTO dense_index_generations (
             generation_id, model_id, embedding_model, index_version,
             dimensions, generation_key, status, created_at,
             updated_at, ready_at, failure_reason
           ) VALUES (?, ?, ?, ?, ?, ?, 'building', ?, ?, NULL, NULL)
           ON CONFLICT(generation_id) DO UPDATE SET
             updated_at = excluded.updated_at`,
        )
        .run(
          generationId,
          modelId,
          input.embeddingModel,
          DENSE_LSH_VERSION,
          input.dimensions,
          input.generationKey,
          input.timestamp,
          input.timestamp,
        );
      let alias = this.denseAlias(input.userId, input.namespace);
      let role: DenseGenerationRegistration['role'];
      if (!alias) {
        this.database
          .prepare(
            `INSERT INTO dense_index_aliases (
               user_id, namespace, active_generation_id,
               building_generation_id, previous_generation_id,
               revision, updated_at
             ) VALUES (?, ?, ?, NULL, NULL, 1, ?)`,
          )
          .run(
            input.userId,
            input.namespace,
            generationId,
            input.timestamp,
          );
        this.database
          .prepare(
            `UPDATE dense_index_generations
             SET status = 'active', updated_at = ?
             WHERE generation_id = ?`,
          )
          .run(input.timestamp, generationId);
        role = 'active';
      } else if (alias.activeGenerationId === generationId) {
        role = 'active';
      } else if (alias.buildingGenerationId === generationId) {
        role = 'building';
      } else if (alias.previousGenerationId === generationId) {
        role = 'previous';
      } else if (!alias.buildingGenerationId) {
        const result = this.database
          .prepare(
            `UPDATE dense_index_aliases
             SET building_generation_id = ?, revision = revision + 1,
                 updated_at = ?
             WHERE user_id = ? AND namespace = ?
               AND revision = ? AND building_generation_id IS NULL`,
          )
          .run(
            generationId,
            input.timestamp,
            input.userId,
            input.namespace,
            alias.revision,
          );
        if (Number(result.changes) !== 1) {
          throw new Error('Dense building alias 已被并发修改');
        }
        role = 'building';
      } else {
        throw new Error(
          `Dense building alias 已被 ${alias.buildingGenerationId} 占用`,
        );
      }
      alias = this.denseAlias(input.userId, input.namespace);
      const generation = this.denseGenerationById(generationId);
      if (!alias || !generation) {
        throw new Error('Dense generation 注册后状态缺失');
      }
      this.database.exec('RELEASE register_dense_generation');
      return { generation, alias, role };
    } catch (error) {
      this.database.exec(
        'ROLLBACK TO register_dense_generation; ' +
        'RELEASE register_dense_generation;',
      );
      throw error;
    }
  }

  denseAlias(
    userId: string,
    namespace: string,
  ): DenseIndexAlias | null {
    const row = this.database
      .prepare(
        `SELECT *
         FROM dense_index_aliases
         WHERE user_id = ? AND namespace = ?`,
      )
      .get(userId, namespace) as DatabaseRow | undefined;
    return row ? rowToDenseAlias(row) : null;
  }

  denseGenerationById(
    generationId: string,
  ): DenseIndexGeneration | null {
    const row = this.database
      .prepare(
        `SELECT *
         FROM dense_index_generations
         WHERE generation_id = ?`,
      )
      .get(generationId) as DatabaseRow | undefined;
    return row ? rowToDenseGeneration(row) : null;
  }

  // 确定性派生 + 只落全局身份行：召回侧需要 generation 行存在（召回自愈
  // 补嵌 memory_embeddings 有 FK），但绝不写 dense_index_aliases——
  // 别名只由写路径注册，纯读主体不在库里留状态。
  ensureDenseGeneration(input: {
    embeddingModel: string;
    dimensions: number;
    generationKey: string;
    timestamp: string;
  }): DenseIndexGeneration {
    if (!Number.isInteger(input.dimensions) || input.dimensions <= 0) {
      throw new Error('dense embedding 维度无效');
    }
    const { modelId, generationId } = deriveDenseGenerationIdentity({
      embeddingModel: input.embeddingModel,
      dimensions: input.dimensions,
      generationKey: input.generationKey,
    });
    this.database
      .prepare(
        `INSERT INTO embedding_model_registry (
           model_id, provider, model_name, created_at, metadata_json
         ) VALUES (?, 'semantic-ranker', ?, ?, '{}')
         ON CONFLICT(model_id) DO NOTHING`,
      )
      .run(modelId, input.embeddingModel, input.timestamp);
    this.database
      .prepare(
        `INSERT INTO dense_index_generations (
           generation_id, model_id, embedding_model, index_version,
           dimensions, generation_key, status, created_at,
           updated_at, ready_at, failure_reason
         ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, NULL)
         ON CONFLICT(generation_id) DO UPDATE SET
           updated_at = excluded.updated_at`,
      )
      .run(
        generationId,
        modelId,
        input.embeddingModel,
        DENSE_LSH_VERSION,
        input.dimensions,
        input.generationKey,
        input.timestamp,
        input.timestamp,
        input.timestamp,
      );
    return this.denseGenerationById(generationId)!;
  }

  denseGenerationsForScope(
    userId: string,
    namespace: string,
  ): DenseIndexGeneration[] {
    const alias = this.denseAlias(userId, namespace);
    if (!alias) return [];
    const generationIds = [
      alias.activeGenerationId,
      alias.buildingGenerationId,
      alias.previousGenerationId,
    ].filter((value): value is string => Boolean(value));
    return [...new Set(generationIds)].flatMap((generationId) => {
      const generation = this.denseGenerationById(generationId);
      return generation ? [generation] : [];
    });
  }

  markDenseGenerationReady(
    generationId: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `UPDATE dense_index_generations
         SET status = CASE
               WHEN status = 'active' THEN 'active'
               ELSE 'ready'
             END,
             ready_at = COALESCE(ready_at, ?),
             updated_at = ?,
             failure_reason = NULL
         WHERE generation_id = ?
           AND status IN ('building', 'ready', 'active')`,
      )
      .run(timestamp, timestamp, generationId);
  }

  failDenseGeneration(
    generationId: string,
    failureReason: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `UPDATE dense_index_generations
         SET status = 'failed', failure_reason = ?, updated_at = ?
         WHERE generation_id = ? AND status != 'active'`,
      )
      .run(failureReason, timestamp, generationId);
  }

  switchDenseAlias(input: {
    userId: string;
    namespace: string;
    generationId: string;
    expectedRevision: number;
    timestamp: string;
  }): DenseIndexAlias {
    const alias = this.denseAlias(input.userId, input.namespace);
    if (
      !alias ||
      alias.buildingGenerationId !== input.generationId ||
      alias.revision !== input.expectedRevision
    ) {
      throw new Error('Dense alias 已变化，拒绝切换');
    }
    const result = this.database
      .prepare(
        `UPDATE dense_index_aliases
         SET active_generation_id = building_generation_id,
             building_generation_id = NULL,
             previous_generation_id = active_generation_id,
             revision = revision + 1,
             updated_at = ?
         WHERE user_id = ? AND namespace = ?
           AND revision = ? AND building_generation_id = ?`,
      )
      .run(
        input.timestamp,
        input.userId,
        input.namespace,
        input.expectedRevision,
        input.generationId,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('Dense alias CAS 切换失败');
    }
    this.database
      .prepare(
        `UPDATE dense_index_generations
         SET status = 'active', updated_at = ?
         WHERE generation_id = ?`,
      )
      .run(input.timestamp, input.generationId);
    if (alias.activeGenerationId) {
      this.database
        .prepare(
          `UPDATE dense_index_generations
           SET status = 'retired', updated_at = ?
           WHERE generation_id = ?`,
        )
        .run(input.timestamp, alias.activeGenerationId);
    }
    return this.denseAlias(input.userId, input.namespace)!;
  }

  rollbackDenseAlias(input: {
    userId: string;
    namespace: string;
    expectedRevision: number;
    timestamp: string;
  }): DenseIndexAlias {
    const alias = this.denseAlias(input.userId, input.namespace);
    if (
      !alias ||
      !alias.previousGenerationId ||
      alias.revision !== input.expectedRevision
    ) {
      throw new Error('Dense alias 没有可回滚 previous 或已变化');
    }
    const result = this.database
      .prepare(
        `UPDATE dense_index_aliases
         SET active_generation_id = previous_generation_id,
             previous_generation_id = active_generation_id,
             revision = revision + 1,
             updated_at = ?
         WHERE user_id = ? AND namespace = ?
           AND revision = ? AND previous_generation_id = ?`,
      )
      .run(
        input.timestamp,
        input.userId,
        input.namespace,
        input.expectedRevision,
        alias.previousGenerationId,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('Dense alias CAS 回滚失败');
    }
    this.database
      .prepare(
        `UPDATE dense_index_generations
         SET status = CASE
               WHEN generation_id = ? THEN 'active'
               WHEN generation_id = ? THEN 'retired'
               ELSE status
             END,
             updated_at = ?
         WHERE generation_id IN (?, ?)`,
      )
      .run(
        alias.previousGenerationId,
        alias.activeGenerationId,
        input.timestamp,
        alias.previousGenerationId,
        alias.activeGenerationId,
      );
    return this.denseAlias(input.userId, input.namespace)!;
  }

  recordDenseGeneration(
    embeddingModel: string,
    dimensions: number,
    generationKey: string,
    timestamp: string,
  ): void {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('dense embedding 维度无效');
    }
    this.database
      .prepare(
        `INSERT INTO dense_index_state (
           embedding_model, index_version, dimensions, probed_at
           , generation_key
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(embedding_model, index_version) DO UPDATE SET
           dimensions = excluded.dimensions,
           generation_key = excluded.generation_key,
           probed_at = excluded.probed_at`,
      )
      .run(
        embeddingModel,
        DENSE_LSH_VERSION,
        dimensions,
        timestamp,
        generationKey,
      );
  }

  denseGeneration(embeddingModel: string): {
    dimensions: number;
    generationKey: string;
  } | null {
    const row = this.database
      .prepare(
        `SELECT dimensions, generation_key
         FROM dense_index_state
         WHERE embedding_model = ? AND index_version = ?`,
      )
      .get(embeddingModel, DENSE_LSH_VERSION);
    const dimensions = Number(row?.dimensions);
    const generationKey = asText(row?.generation_key);
    return Number.isInteger(dimensions) &&
      dimensions > 0 &&
      generationKey
      ? { dimensions, generationKey }
      : null;
  }

  private removeLexical(memoryId: string): void {
    this.database
      .prepare(
        `DELETE FROM memory_ann_index
         WHERE memory_id = ? AND index_model = ?`,
      )
      .run(memoryId, ANN_INDEX_MODEL);
    this.database
      .prepare(
        `DELETE FROM memory_term_index
         WHERE memory_id = ? AND index_model = ?`,
      )
      .run(memoryId, ANN_INDEX_MODEL);
  }

  search(input: HybridSearchInput): HybridCandidate[] {
    return this.searchWithDiagnostics(input).candidates;
  }

  searchWithDiagnostics(input: HybridSearchInput): HybridSearchResult {
    const limit = Math.max(1, Math.min(input.limit || 120, 500));
    const perChannel = Math.max(40, Math.min(limit, 160));
    const lexicalSearch = this.searchLexical(input, perChannel);
    const annSearch =
      input.denseVector &&
      input.denseVector.length > 0 &&
      input.denseModel
        ? this.searchDense(input, perChannel)
        : this.searchAnn(input, perChannel);
    const termSearch = this.searchTerms(input, perChannel);
    const lexical = lexicalSearch.rows;
    const ann = annSearch.rows;
    const terms = termSearch.rows;
    const fused = new Map<string, HybridCandidate>();

    for (const [index, row] of lexical.entries()) {
      fused.set(row.id, {
        id: row.id,
        fusedScore: 1 / (60 + index + 1),
        lexicalRank: index + 1,
        annRank: null,
        annHits: 0,
        termRank: null,
        termHits: 0,
        graphRank: null,
      });
    }
    for (const [index, row] of ann.entries()) {
      const current = fused.get(row.id) || {
        id: row.id,
        fusedScore: 0,
        lexicalRank: null,
        annRank: null,
        annHits: 0,
        termRank: null,
        termHits: 0,
        graphRank: null,
      };
      current.fusedScore += 1 / (60 + index + 1);
      current.annRank = index + 1;
      current.annHits = row.hits;
      fused.set(row.id, current);
    }
    for (const [index, row] of terms.entries()) {
      const current = fused.get(row.id) || {
        id: row.id,
        fusedScore: 0,
        lexicalRank: null,
        annRank: null,
        annHits: 0,
        termRank: null,
        termHits: 0,
        graphRank: null,
      };
      current.fusedScore += 1 / (60 + index + 1);
      current.termRank = index + 1;
      current.termHits = row.hits;
      fused.set(row.id, current);
    }

    const ranked = [...fused.values()]
      .sort((left, right) => {
        if (right.fusedScore !== left.fusedScore) {
          return right.fusedScore - left.fusedScore;
        }
        return left.id.localeCompare(right.id);
      });
    const valid = this.filterValidDerivedSources(ranked);
    const candidates = valid.slice(0, limit);
    return {
      candidates,
      diagnostics: {
        limit,
        perChannelLimit: perChannel,
        annMode: input.denseVector && input.denseModel
          ? 'dense_lsh'
          : 'minhash_ann',
        channels: {
          lexical: lexicalSearch.counts,
          ann: annSearch.counts,
          term: termSearch.counts,
        },
        fusion: {
          rawCount: ranked.length,
          validCount: valid.length,
          invalidDerivedSourceCount: Math.max(
            ranked.length - valid.length,
            0,
          ),
          returnedCount: candidates.length,
          cappedCount: Math.max(valid.length - candidates.length, 0),
        },
      },
    };
  }

  searchDenseChannel(
    input: HybridSearchInput,
    limit = 40,
  ): DenseChannelSearchResult {
    const boundedLimit = Math.max(1, Math.min(limit, 160));
    const result = this.searchDense(input, boundedLimit);
    return {
      candidates: result.rows,
      diagnostics: result.counts,
    };
  }

  expandGraph(
    input: HybridSearchInput,
    seedIds: string[],
    limit = 24,
  ): HybridCandidate[] {
    return this.expandGraphWithDiagnostics(input, seedIds, limit).candidates;
  }

  expandGraphWithDiagnostics(
    input: HybridSearchInput,
    seedIds: string[],
    limit = 24,
  ): HybridGraphSearchResult {
    const seeds = [...new Set(seedIds.filter(Boolean))];
    const boundedLimit = Math.max(0, Math.min(limit, 100));
    if (seeds.length === 0 || boundedLimit === 0) {
      return { candidates: [], diagnostics: emptyCandidateCounts() };
    }
    const scope = scopeSql('m', input);
    const placeholders = seeds.map(() => '?').join(', ');
    const rows = this.database
      .prepare(
        `WITH graph_neighbors AS (
           SELECT
             CASE
               WHEN e.from_memory_item_id IN (${placeholders})
                 THEN e.to_memory_item_id
               ELSE e.from_memory_item_id
             END AS memory_id,
             COUNT(*) AS edge_hits
           FROM memory_edges e
           WHERE e.from_memory_item_id IN (${placeholders})
              OR e.to_memory_item_id IN (${placeholders})
           GROUP BY memory_id
         )
         SELECT m.id, graph_neighbors.edge_hits,
                COUNT(*) OVER() AS raw_count
         FROM graph_neighbors
         JOIN memories m ON m.id = graph_neighbors.memory_id
         WHERE m.id NOT IN (${placeholders})
           AND ${scope.sql.join(' AND ')}
           AND ${validDerivedSourceSql('m')}
         ORDER BY graph_neighbors.edge_hits DESC, m.updated_at DESC, m.id ASC
         LIMIT ?`,
      )
      .all(
        ...seeds,
        ...seeds,
        ...seeds,
        ...seeds,
        ...scope.values,
        boundedLimit,
      ) as DatabaseRow[];
    const result = channelResult(rows, (row) => ({
      id: asText(row.id),
    }));
    return {
      candidates: result.rows.map((row, index) => ({
        id: row.id,
        fusedScore: 1 / (180 + index + 1),
        lexicalRank: null,
        annRank: null,
        annHits: 0,
        termRank: null,
        termHits: 0,
        graphRank: index + 1,
      })),
      diagnostics: result.counts,
    };
  }

  private filterValidDerivedSources(
    candidates: HybridCandidate[],
  ): HybridCandidate[] {
    if (candidates.length === 0) return [];
    const rows = this.database
      .prepare(
        `SELECT m.id
         FROM memories m
         WHERE m.id IN (${candidates.map(() => '?').join(', ')})
           AND ${validDerivedSourceSql('m')}`,
      )
      .all(...candidates.map((candidate) => candidate.id)) as
      DatabaseRow[];
    const validIds = new Set(rows.map((row) => asText(row.id)));
    return candidates.filter((candidate) => validIds.has(candidate.id));
  }

  private searchLexical(
    input: HybridSearchInput,
    limit: number,
  ): HybridChannelResult<{ id: string }> {
    const plan = lexicalQueryPlan(input.query);
    const phrase = plan.match
      ? this.searchLexicalPhrase(input, limit, plan.match)
      : { rows: [], counts: emptyCandidateCounts() };
    const substring = plan.substrings.length
      ? this.searchLexicalSubstring(input, limit, plan.substrings)
      : { rows: [], counts: emptyCandidateCounts() };
    // 短语命中（bm25 排序）优先，子串命中补齐；同一条记忆只保留首次出现的位置。
    const seen = new Set<string>();
    const rows: Array<{ id: string }> = [];
    for (const row of [...phrase.rows, ...substring.rows]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    const rawCount = phrase.counts.rawCount + substring.counts.rawCount;
    return {
      rows,
      counts: {
        rawCount,
        returnedCount: rows.length,
        cappedCount: Math.max(rawCount - rows.length, 0),
      },
    };
  }

  private searchLexicalPhrase(
    input: HybridSearchInput,
    limit: number,
    match: string,
  ): HybridChannelResult<{ id: string }> {
    const scope = scopeSql('m', input);
    const rawCount = Number(
      this.database
        .prepare(
          `SELECT COUNT(*) AS raw_count
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.memory_id
           WHERE memories_fts MATCH ?
             AND ${scope.sql.join(' AND ')}`,
        )
        .get(match, ...scope.values)?.raw_count,
    ) || 0;
    const rows = this.database
      .prepare(
        `SELECT memories_fts.memory_id AS id,
                bm25(memories_fts) AS lexical_score
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.memory_id
         WHERE memories_fts MATCH ?
           AND ${scope.sql.join(' AND ')}
         ORDER BY lexical_score ASC, m.updated_at DESC
         LIMIT ?`,
      )
      .all(match, ...scope.values, limit) as DatabaseRow[];
    return channelResult(
      rows,
      (row) => ({ id: asText(row.id) }),
      rawCount,
    );
  }

  // trigram 索引对不足 3 字的短语无能为力，只能回到基表做子串匹配。
  // 代价是逐行扫描（无法走索引），换来的是中文短查询不再静默空转；
  // 查询词数量已由 LEXICAL_SUBSTRING_CAP 限死，作用域条件照旧生效。
  private searchLexicalSubstring(
    input: HybridSearchInput,
    limit: number,
    needles: string[],
  ): HybridChannelResult<{ id: string }> {
    const scope = scopeSql('m', input);
    const columns = ['m.title', 'm.content', 'm.summary', 'm.tags_json'];
    const likeArgs: SQLInputValue[] = [];
    const filterArgs: SQLInputValue[] = [];
    const hitParts: string[] = [];
    const filterParts: string[] = [];
    for (const needle of needles) {
      const like = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      hitParts.push(
        `(${columns
          .map((column) => `CASE WHEN ${column} LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`)
          .join(' + ')})`,
      );
      filterParts.push(
        `(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
      );
      for (let index = 0; index < columns.length; index += 1) {
        likeArgs.push(like);
        filterArgs.push(like);
      }
    }
    const rows = this.database
      .prepare(
        `SELECT m.id,
                (${hitParts.join(' + ')}) AS substring_hits,
                COUNT(*) OVER() AS raw_count
         FROM memories m
         WHERE (${filterParts.join(' OR ')})
           AND ${scope.sql.join(' AND ')}
         ORDER BY substring_hits DESC, m.updated_at DESC, m.id ASC
         LIMIT ?`,
      )
      .all(
        ...likeArgs,
        ...filterArgs,
        ...scope.values,
        limit,
      ) as DatabaseRow[];
    return channelResult(rows, (row) => ({ id: asText(row.id) }));
  }

  private searchAnn(
    input: HybridSearchInput,
    limit: number,
  ): HybridChannelResult<{ id: string; hits: number }> {
    const buckets = minHashBuckets(input.query);
    if (buckets.length === 0) {
      return { rows: [], counts: emptyCandidateCounts() };
    }
    const bucketRows = buckets.map(() => '(?, ?)').join(', ');
    const bucketValues: SQLInputValue[] = [];
    for (const [band, bucket] of buckets.entries()) {
      bucketValues.push(band, bucket);
    }
    const scope = scopeSql('m', input);
    const rows = this.database
      .prepare(
        `SELECT a.memory_id AS id, COUNT(*) AS hits,
                COUNT(*) OVER() AS raw_count
         FROM memory_ann_index a INDEXED BY memory_ann_bucket_idx
         JOIN memories m ON m.id = a.memory_id
         WHERE a.index_model = ?
           AND (a.band, a.bucket) IN (VALUES ${bucketRows})
           AND ${scope.sql.join(' AND ')}
         GROUP BY a.memory_id
         ORDER BY hits DESC, m.updated_at DESC
         LIMIT ?`,
      )
      .all(
        ANN_INDEX_MODEL,
        ...bucketValues,
        ...scope.values,
        limit,
      ) as DatabaseRow[];
    return channelResult(rows, (row) => ({
      id: asText(row.id),
      hits: Number(row.hits),
    }));
  }

  private searchDense(
    input: HybridSearchInput,
    limit: number,
  ): HybridChannelResult<{ id: string; hits: number }> {
    const buckets = denseLshBuckets(input.denseVector!);
    if (
      buckets.length === 0 ||
      !input.denseModel ||
      !input.denseGenerationKey ||
      !input.denseGenerationId
    ) return { rows: [], counts: emptyCandidateCounts() };
    const bucketRows = buckets.map(() => '(?, ?)').join(', ');
    const bucketValues: SQLInputValue[] = [];
    for (const [band, bucket] of buckets.entries()) {
      bucketValues.push(band, bucket);
    }
    const scope = scopeSql('m', input);
    const rows = this.database
      .prepare(
        `SELECT d.memory_id AS id, COUNT(*) AS hits,
                COUNT(*) OVER() AS raw_count
         FROM memory_dense_lsh d
           INDEXED BY memory_dense_lsh_bucket_idx
         JOIN memories m ON m.id = d.memory_id
         WHERE d.generation_id = ?
           AND d.embedding_model = ?
           AND d.index_version = ?
           AND d.dimensions = ?
           AND d.generation_key = ?
           AND d.memory_revision = m.semantic_revision
           AND (d.band, d.bucket) IN (VALUES ${bucketRows})
           AND ${scope.sql.join(' AND ')}
         GROUP BY d.memory_id
         ORDER BY hits DESC, m.updated_at DESC
         LIMIT ?`,
      )
      .all(
        input.denseGenerationId,
        input.denseModel,
        DENSE_LSH_VERSION,
        input.denseVector!.length,
        input.denseGenerationKey,
        ...bucketValues,
        ...scope.values,
        limit,
      ) as DatabaseRow[];
    const approximate = channelResult(rows, (row) => ({
      id: asText(row.id),
      hits: Number(row.hits),
    }));
    if (rows.length >= limit) return approximate;

    const exactRows = this.database
      .prepare(
        `SELECT m.id, e.embedding
         FROM memories m
         JOIN memory_embeddings e
           ON e.memory_id = m.id
          AND e.generation_id = ?
         WHERE e.model = ?
           AND e.dimensions = ?
           AND e.generation_key = ?
           AND e.memory_revision = m.semantic_revision
           AND length(e.embedding) = e.dimensions * ?
           AND ${scope.sql.join(' AND ')}
         ORDER BY m.updated_at DESC, m.id ASC
         LIMIT ?`,
      )
      .all(
        input.denseGenerationId,
        input.denseModel,
        input.denseVector!.length,
        input.denseGenerationKey,
        Float32Array.BYTES_PER_ELEMENT,
        ...scope.values,
        DENSE_EXACT_FALLBACK_MAX_CANDIDATES + 1,
      ) as DatabaseRow[];
    if (
      exactRows.length === 0 ||
      exactRows.length > DENSE_EXACT_FALLBACK_MAX_CANDIDATES ||
      rows.length >= Math.min(limit, exactRows.length)
    ) {
      return approximate;
    }
    const approximateHits = new Map(
      rows.map((row) => [asText(row.id), Number(row.hits)]),
    );
    const exact = exactRows
      .flatMap((row) => {
        if (!(row.embedding instanceof Uint8Array)) return [];
        const vector = bufferToVector(row.embedding);
        if (vector.length !== input.denseVector!.length) return [];
        return [{
          id: asText(row.id),
          hits: approximateHits.get(asText(row.id)) || 0,
          similarity: cosineSimilarity(input.denseVector!, vector),
        }];
      })
      .sort(
        (left, right) =>
          right.similarity - left.similarity ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map(({ id, hits }) => ({ id, hits }));
    return {
      rows: exact,
      counts: {
        rawCount: exactRows.length,
        returnedCount: exact.length,
        cappedCount: Math.max(exactRows.length - exact.length, 0),
        strategy: 'exact_fallback',
        scannedCount: exactRows.length,
      },
    };
  }

  private searchTerms(
    input: HybridSearchInput,
    limit: number,
  ): HybridChannelResult<{ id: string; hits: number }> {
    const terms = indexedTerms(input.query);
    if (terms.length === 0) {
      return { rows: [], counts: emptyCandidateCounts() };
    }
    const scope = scopeSql('m', input);
    const rows = this.database
      .prepare(
        `SELECT t.memory_id AS id, COUNT(*) AS hits,
                COUNT(*) OVER() AS raw_count
         FROM memory_term_index t
         JOIN memories m ON m.id = t.memory_id
         WHERE t.index_model = ?
           AND t.term IN (${terms.map(() => '?').join(', ')})
           AND ${scope.sql.join(' AND ')}
         GROUP BY t.memory_id
         ORDER BY hits DESC, m.updated_at DESC
         LIMIT ?`,
      )
      .all(
        ANN_INDEX_MODEL,
        ...terms,
        ...scope.values,
        limit,
      ) as DatabaseRow[];
    return channelResult(rows, (row) => ({
      id: asText(row.id),
      hits: Number(row.hits),
    }));
  }
}
