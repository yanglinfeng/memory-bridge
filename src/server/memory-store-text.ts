/**
 * 行映射/rerank 预算/证据摘要文本（原 memory-store.ts 1067-1604 行）。
 *
 * 由 memory-store.ts 机械搬迁而来（仅加 export 前缀），公开符号由门面 re-export。
 */

import type {
  DatabaseRow,
  MemoryEvidenceDigest,
} from './memory-store-types.js';
import { MEMORY_KINDS } from './types.js';
import type { MemoryRecord } from './types.js';
import {
  asNullableString,
  asString,
  cleanText,
  normalizeClassification,
  parseJson,
} from './memory-store-utils.js';
import { config } from './config.js';
import type { DatabaseSync } from 'node:sqlite';
import { containsCredentialSecret } from './memory-extractor.js';
import type { SemanticCandidate } from './semantic-ranker.js';
import { createHash } from 'node:crypto';
import { vectorToBuffer } from './embedding.js';

export function rowToMemory(row: DatabaseRow): MemoryRecord {
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

export function memoryText(memory: Pick<
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

export function semanticMemoryText(memory: Pick<
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

export function boundedEvidenceExcerpt(value: string, maximum = 180): string {
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
export const RERANK_PROVIDER_CANDIDATE_LIMIT = 16;

export const RERANK_PROVIDER_QUERY_TEXT_BUDGET = 128;

export function boundedHeadAndTail(value: string, maximum: number): string {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  if (maximum <= 1) return characters.slice(0, maximum).join('');
  const contentBudget = maximum - 1;
  const headLength = Math.ceil(contentBudget * 0.85);
  return `${characters.slice(0, headLength).join('')}…${
    characters.slice(-(contentBudget - headLength)).join('')
  }`;
}

export interface AtomicRerankClaim {
  subject: string;
  predicate: string;
  value: string;
  negated: boolean;
}

export function parseAtomicRerankClaim(value: string): AtomicRerankClaim | null {
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

export function atomicRerankSemanticFloor(claim: AtomicRerankClaim): string {
  return `原子|主体=${[...claim.subject][0] || '?'}|谓词=${
    [...claim.predicate][0] || '?'
  }|否定=${claim.negated ? '是' : '否'}|值=`;
}

export function compactAtomicRerankText(claim: AtomicRerankClaim): string {
  return `原子|主体=${claim.subject}|谓词=${claim.predicate}` +
    `|否定=${claim.negated ? '是' : '否'}|值=${claim.value}`;
}

export function waterFillLengths(
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

export interface BoundedRerankQuery {
  text: string;
  originalCharacters: number;
  providerCharacters: number;
  truncated: boolean;
}

export const RERANK_QUERY_CRITICAL_CLAUSE_PATTERNS = [
  /(?:关键|限定|明确|重点|核心|真正问题)/u,
  /(?:不|没|无|否|停止|取消|避免|排除|不得|不要|不是|并非)/u,
  /(?:最近|今天|昨天|明天|本周|上周|下周|本月|上月|何时|时间|之前|之后)/u,
  /(?:所有|全部|列出|清单|分别|比较|哪个|哪些|多少)/u,
  /(?:什么|怎么|怎样|为什么|是否|能否|有没有|吗|呢|？|\?)/u,
];

export function boundedProviderRankingQuery(value: string): BoundedRerankQuery {
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

export function boundedAtomicRerankText(value: string, maximum: number): string {
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

export function rerankCandidateMinimumBudget(value: string): number {
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

export function rerankCandidateDemand(value: string): number {
  const length = [...value].length;
  const atomic = parseAtomicRerankClaim(value);
  return atomic
    ? Math.min(length, [...compactAtomicRerankText(atomic)].length)
    : length;
}

export function applyRerankCandidateTextBudget<T extends { memory: string }>(
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

export const evidenceDigestSqlFunctionDatabases = new WeakSet<DatabaseSync>();

export function ensureEvidenceDigestSqlFunctions(database: DatabaseSync): void {
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

export function evidenceDigestText(
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

export function stripUntrustedRerankControlLines(value: string): string {
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

export function trustedDigestUserEvidenceText(
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

export function semanticRerankText(
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

export function semanticCandidateEvidence(
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

export function semanticTextHash(value: string): string {
  return createHash('sha256')
    .update(value.normalize('NFKC'))
    .digest('hex');
}

export function denseGenerationKey(vector: Float32Array): string {
  return createHash('sha256')
    .update(vectorToBuffer(vector))
    .digest('hex');
}

export function defaultTitle(content: string): string {
  const firstLine = content.split(/\r?\n/)[0].trim();
  return firstLine.slice(0, 60) || '未命名记忆';
}

export function isValidKind(value: string): value is MemoryRecord['kind'] {
  return MEMORY_KINDS.includes(value as MemoryRecord['kind']);
}

export function recencyScore(updatedAt: string): number {
  const ageMs = Math.max(0, Date.now() - new Date(updatedAt).getTime());
  const ageDays = ageMs / 86_400_000;
  return Math.exp(-ageDays / 180);
}

