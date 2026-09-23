import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  isDerivedSummarySource,
  isGovernanceExemptSource,
  type ConsolidationProvider,
  type ConsolidationScope,
  type ConsolidationSentence,
  type ConsolidationSource,
  validateConsolidationDraftSources,
  withMemoryStoreTransaction,
} from './memory-consolidator.js';
import { MemoryStore } from './memory-store.js';
import type { MemoryScopeType } from './types.js';

type DatabaseRow = Record<string, unknown>;

export type HierarchicalSummaryType = 'session' | 'day' | 'week';

export interface HierarchicalSummaryInput {
  userId: string;
  namespace: string;
  summaryType: HierarchicalSummaryType;
  bucketKey: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  timezoneOffsetMinutes?: number;
}

export interface HierarchicalSummaryResult {
  status:
    | 'created'
    | 'rebuilt'
    | 'unchanged'
    | 'blocked'
    | 'failed'
    | 'failed_preserved';
  summaryId: string | null;
  memoryId: string | null;
  sourceCount: number;
  sentenceCount: number;
  sourceFingerprint: string | null;
  errorCode?: 'provider_failed' | 'source_invalid';
}

export interface HierarchicalSummaryInvalidationResult {
  invalidated: number;
  memoryIds: string[];
}

interface NormalizedSummaryInput extends HierarchicalSummaryInput {
  timezoneOffsetMinutes: number;
}

interface EpisodeSource extends ConsolidationSource {
  episodeId: string;
  sessionId: string;
  userTurnId: string;
  assistantTurnId: string;
  contentHash: string;
}

function text(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim();
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return text(value) || null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedInput(
  input: HierarchicalSummaryInput,
): NormalizedSummaryInput {
  const userId = text(input.userId);
  const namespace = text(input.namespace);
  const bucketKey = text(input.bucketKey);
  const scopeKey = text(input.scopeKey);
  if (!userId || !namespace || !bucketKey || !scopeKey) {
    throw new Error('层级摘要缺少 owner、namespace、bucket 或 scope');
  }
  if (!['session', 'day', 'week'].includes(input.summaryType)) {
    throw new Error('层级摘要类型无效');
  }
  if (!['personal', 'project', 'role', 'session'].includes(input.scopeType)) {
    throw new Error('层级摘要作用域无效');
  }
  const timezoneOffsetMinutes = input.timezoneOffsetMinutes ?? 0;
  if (
    !Number.isInteger(timezoneOffsetMinutes) ||
    timezoneOffsetMinutes < -840 ||
    timezoneOffsetMinutes > 840
  ) {
    throw new Error('层级摘要时区偏移必须是 -840 到 840 的整数分钟');
  }
  if (input.summaryType === 'day') {
    parseDay(bucketKey);
  }
  if (input.summaryType === 'week') {
    parseIsoWeek(bucketKey);
  }
  return {
    userId,
    namespace,
    summaryType: input.summaryType,
    bucketKey,
    scopeType: input.scopeType,
    scopeKey,
    timezoneOffsetMinutes,
  };
}

function parseDay(value: string): { year: number; month: number; day: number } {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) throw new Error('day bucketKey 必须是 YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error('day bucketKey 不是有效日期');
  }
  return { year, month, day };
}

function isoWeekStart(year: number, week: number): Date {
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const weekday = januaryFourth.getUTCDay() || 7;
  const monday = new Date(januaryFourth);
  monday.setUTCDate(januaryFourth.getUTCDate() - weekday + 1 + (week - 1) * 7);
  return monday;
}

function isoWeekIdentity(date: Date): { year: number; week: number } {
  const thursday = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const weekday = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - weekday);
  const year = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    (((thursday.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7,
  );
  return { year, week };
}

function parseIsoWeek(value: string): { year: number; week: number } {
  const match = value.match(/^(\d{4})-W(\d{2})$/u);
  if (!match) throw new Error('week bucketKey 必须是 YYYY-Www');
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) throw new Error('ISO week 无效');
  const identity = isoWeekIdentity(isoWeekStart(year, week));
  if (identity.year !== year || identity.week !== week) {
    throw new Error('ISO week 无效');
  }
  return { year, week };
}

function bucketRange(input: NormalizedSummaryInput): {
  start: string;
  end: string;
} | null {
  if (input.summaryType === 'session') return null;
  const offsetMs = input.timezoneOffsetMinutes * 60_000;
  let localStart: Date;
  let days: number;
  if (input.summaryType === 'day') {
    const { year, month, day } = parseDay(input.bucketKey);
    localStart = new Date(Date.UTC(year, month - 1, day));
    days = 1;
  } else {
    const { year, week } = parseIsoWeek(input.bucketKey);
    localStart = isoWeekStart(year, week);
    days = 7;
  }
  const startMs = localStart.getTime() - offsetMs;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + days * 86_400_000).toISOString(),
  };
}

function providerScope(input: NormalizedSummaryInput): ConsolidationScope {
  return {
    userId: input.userId,
    namespace: input.namespace,
    scopeType: input.summaryType === 'session' ? 'session' : 'topic',
    scopeKey: `hierarchical:${input.summaryType}:${input.bucketKey}`,
    accessScopeType: input.scopeType,
    accessScopeKey: input.scopeKey,
  };
}

function summaryTitle(input: NormalizedSummaryInput): string {
  const label: Record<HierarchicalSummaryType, string> = {
    session: '会话摘要',
    day: '每日摘要',
    week: '每周摘要',
  };
  return `${label[input.summaryType]}：${input.bucketKey}`;
}

function summaryFingerprint(
  input: NormalizedSummaryInput,
  provider: ConsolidationProvider,
  sources: EpisodeSource[],
): string {
  return sha256(JSON.stringify({
    contract: 'hierarchical-summary-v1',
    input,
    model: provider.model,
    promptVersion: provider.promptVersion,
    sources: sources.map((source) => ({
      episodeId: source.episodeId,
      memoryVersionId: source.memoryVersionId,
      contentHash: source.contentHash,
      occurredAt: source.occurredAt,
    })),
  }));
}

function activeSummaryQuery(): string {
  return `SELECT s.*, m.status AS memory_status, m.source AS memory_source
          FROM conversation_memory_summaries s
          JOIN memories m ON m.id = s.memory_id
          WHERE s.user_id = ?
            AND s.namespace = ?
            AND s.summary_type = ?
            AND s.bucket_key = ?
            AND s.scope_type = ?
            AND s.scope_key = ?
            AND s.status = 'active'
          ORDER BY s.updated_at DESC, s.id DESC
          LIMIT 1`;
}

export class HierarchicalSummaryService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly memoryStore: MemoryStore,
    private readonly provider: ConsolidationProvider,
  ) {}

  async summarizeBucket(
    rawInput: HierarchicalSummaryInput,
  ): Promise<HierarchicalSummaryResult> {
    const input = normalizedInput(rawInput);
    let existing = this.findActive(input);
    if (existing && !this.summarySourcesValid(text(existing.id))) {
      this.invalidateSummary(existing, 'source_invalid');
      existing = null;
    }
    const sources = this.loadSources(input);
    if (sources.length === 0) {
      return {
        status: 'blocked',
        summaryId: null,
        memoryId: null,
        sourceCount: 0,
        sentenceCount: 0,
        sourceFingerprint: null,
        errorCode: 'source_invalid',
      };
    }
    const fingerprint = summaryFingerprint(input, this.provider, sources);
    if (
      existing &&
      text(existing.source_fingerprint) === fingerprint &&
      text(existing.memory_status) === 'active' &&
      text(existing.memory_source) === 'hierarchical_summary'
    ) {
      return {
        status: 'unchanged',
        summaryId: text(existing.id),
        memoryId: text(existing.memory_id),
        sourceCount: sources.length,
        sentenceCount: this.summarySentenceCount(text(existing.memory_id)),
        sourceFingerprint: fingerprint,
      };
    }

    let sentences: ConsolidationSentence[];
    try {
      const draft = await this.provider.consolidate(
        providerScope(input),
        sources,
      );
      sentences = (
        await validateConsolidationDraftSources(
          this.provider,
          providerScope(input),
          sources,
          draft,
        )
      ).sentences;
    } catch {
      return {
        status: existing ? 'failed_preserved' : 'failed',
        summaryId: existing ? text(existing.id) : null,
        memoryId: existing ? text(existing.memory_id) : null,
        sourceCount: sources.length,
        sentenceCount: existing
          ? this.summarySentenceCount(text(existing.memory_id))
          : 0,
        sourceFingerprint: fingerprint,
        errorCode: 'provider_failed',
      };
    }

    return withMemoryStoreTransaction(this.database, () => {
      const latestSources = this.loadSources(input);
      if (summaryFingerprint(input, this.provider, latestSources) !== fingerprint) {
        throw new Error('层级摘要来源在生成期间发生变化');
      }
      const current = this.findActive(input);
      if (
        current &&
        text(current.source_fingerprint) === fingerprint &&
        this.summarySourcesValid(text(current.id))
      ) {
        return {
          status: 'unchanged',
          summaryId: text(current.id),
          memoryId: text(current.memory_id),
          sourceCount: latestSources.length,
          sentenceCount: this.summarySentenceCount(text(current.memory_id)),
          sourceFingerprint: fingerprint,
        };
      }
      const prior = current || existing;
      const summaryId = randomUUID();
      const timestamp = new Date().toISOString();
      const content = [
        `[派生摘要：${input.summaryType}/${input.bucketKey}]`,
        ...sentences.map((sentence) => sentence.text),
      ].join('\n');
      const memory = this.memoryStore.remember({
        userId: input.userId,
        namespace: input.namespace,
        kind: 'event',
        title: summaryTitle(input),
        content,
        summary: sentences.map((sentence) => sentence.text).join(' '),
        tags: ['derived', 'hierarchical-summary', `summary:${input.summaryType}`],
        importance: 0.65,
        confidence: 1,
        source: 'hierarchical_summary',
        sourceRef: `hierarchical-summary:${summaryId}`,
        occurredAt: latestSources.at(-1)?.occurredAt || undefined,
        validFrom: timestamp,
        supersedesId: prior ? text(prior.memory_id) : undefined,
        stableKey: `hierarchical:${input.summaryType}:` +
          `${sha256([input.userId, input.namespace, input.bucketKey,
            input.scopeType, input.scopeKey, fingerprint].join('\u0000'))}`,
        idempotencyKey: `hierarchical-summary:${fingerprint}`,
        predicateKey: `hierarchical::${input.summaryType}::${input.bucketKey}`,
        normalizedValueHash: fingerprint,
        normalizedValue: fingerprint,
        predicateCardinality: 'single',
        scopeType: input.scopeType,
        scopeKey: input.scopeKey,
        sourceAuthority: 'imported',
        createdBy: `hierarchical-summary:${this.provider.model}`,
      }).memory;
      const versionId = text(this.database.prepare(
        `SELECT current_version_id
         FROM memory_items
         WHERE id = ? AND user_id = ? AND namespace = ?`,
      ).get(memory.id, input.userId, input.namespace)?.current_version_id);
      if (!versionId) {
        throw new Error('层级摘要持久化缺少当前版本');
      }

      if (prior) {
        this.database.prepare(
          `UPDATE conversation_memory_summaries
           SET status = 'superseded', updated_at = ?
           WHERE id = ? AND status = 'active'`,
        ).run(timestamp, text(prior.id));
      }
      this.database.prepare(
        `INSERT INTO conversation_memory_summaries (
           id, memory_id, user_id, namespace, summary_type, bucket_key,
           scope_type, scope_key, source_fingerprint, source_count,
           status, model, prompt_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(
        summaryId,
        memory.id,
        input.userId,
        input.namespace,
        input.summaryType,
        input.bucketKey,
        input.scopeType,
        input.scopeKey,
        fingerprint,
        latestSources.length,
        this.provider.model,
        this.provider.promptVersion,
        timestamp,
        timestamp,
      );
      const insertSource = this.database.prepare(
        `INSERT INTO conversation_memory_summary_sources (
           summary_id, episode_id, ordinal
         ) VALUES (?, ?, ?)`,
      );
      latestSources.forEach((source, ordinal) => {
        insertSource.run(summaryId, source.episodeId, ordinal);
      });
      this.insertSentenceEvidence(
        versionId,
        summaryId,
        latestSources,
        sentences,
        timestamp,
      );
      return {
        status: prior ? 'rebuilt' : 'created',
        summaryId,
        memoryId: memory.id,
        sourceCount: latestSources.length,
        sentenceCount: sentences.length,
        sourceFingerprint: fingerprint,
      };
    });
  }

  invalidateSources(
    episodeIds: string[],
  ): HierarchicalSummaryInvalidationResult {
    const normalizedIds = [...new Set(episodeIds.map(text).filter(Boolean))];
    if (normalizedIds.length === 0) {
      return { invalidated: 0, memoryIds: [] };
    }
    const rows = this.database.prepare(
      `SELECT DISTINCT s.*
       FROM conversation_memory_summaries s
       JOIN conversation_memory_summary_sources source
         ON source.summary_id = s.id
       WHERE source.episode_id IN (${normalizedIds.map(() => '?').join(', ')})
         AND s.status = 'active'`,
    ).all(...normalizedIds) as DatabaseRow[];
    if (rows.length === 0) return { invalidated: 0, memoryIds: [] };
    return withMemoryStoreTransaction(this.database, () => {
      const memoryIds: string[] = [];
      for (const row of rows) {
        this.invalidateSummary(row, 'source_invalid', false);
        memoryIds.push(text(row.memory_id));
      }
      return { invalidated: rows.length, memoryIds };
    });
  }

  private loadSources(input: NormalizedSummaryInput): EpisodeSource[] {
    const values: SQLInputValue[] = [
      input.userId,
      input.namespace,
      input.scopeType,
      input.scopeKey,
    ];
    let bucketFilter = '';
    const range = bucketRange(input);
    if (input.summaryType === 'session') {
      bucketFilter = 'AND e.session_id = ?';
      values.push(input.bucketKey);
    } else if (range) {
      bucketFilter = 'AND e.occurred_at >= ? AND e.occurred_at < ?';
      values.push(range.start, range.end);
    }
    const rows = this.database.prepare(
      `SELECT e.id AS episode_id, e.session_id, e.user_turn_id,
              e.assistant_turn_id, e.content_hash, e.occurred_at,
              m.id AS memory_id, m.kind, m.title, m.content, m.updated_at,
              m.source, i.current_version_id AS memory_version_id,
              i.predicate_key, i.normalized_value,
              i.normalized_value_hash, v.negated,
              v.occurred_at AS version_occurred_at,
              v.valid_from, v.valid_to
       FROM conversation_episodes e
       JOIN memories m ON m.id = e.memory_id
       JOIN memory_items i ON i.id = m.id
       JOIN memory_versions v ON v.id = i.current_version_id
       WHERE e.user_id = ?
         AND e.namespace = ?
         AND e.scope_type = ?
         AND e.scope_key = ?
         AND e.status = 'active'
         AND m.user_id = e.user_id
         AND m.namespace = e.namespace
         AND m.scope_type = e.scope_type
         AND m.scope_key = e.scope_key
         AND m.status = 'active'
         AND i.status = 'active'
         AND m.source = 'conversation_episode'
         ${bucketFilter}
       ORDER BY e.occurred_at ASC, e.id ASC`,
    ).all(...values) as DatabaseRow[];
    return rows.flatMap((row) => {
      if (isGovernanceExemptSource(row.source)) return [];
      return [{
        episodeId: text(row.episode_id),
        sessionId: text(row.session_id),
        userTurnId: text(row.user_turn_id),
        assistantTurnId: text(row.assistant_turn_id),
        contentHash: text(row.content_hash),
        memoryId: text(row.memory_id),
        memoryVersionId: text(row.memory_version_id),
        kind: text(row.kind) as ConsolidationSource['kind'],
        title: text(row.title),
        content: text(row.content),
        updatedAt: text(row.updated_at),
        predicateKey: text(row.predicate_key),
        normalizedValue: nullableText(row.normalized_value),
        normalizedValueHash: nullableText(row.normalized_value_hash),
        negated: Number(row.negated) === 1,
        occurredAt: nullableText(row.version_occurred_at) ||
          nullableText(row.occurred_at),
        validFrom: nullableText(row.valid_from),
        validTo: nullableText(row.valid_to),
      }];
    });
  }

  private findActive(input: NormalizedSummaryInput): DatabaseRow | null {
    return (this.database.prepare(activeSummaryQuery()).get(
      input.userId,
      input.namespace,
      input.summaryType,
      input.bucketKey,
      input.scopeType,
      input.scopeKey,
    ) as DatabaseRow | undefined) || null;
  }

  private summarySourcesValid(summaryId: string): boolean {
    const row = this.database.prepare(
      `SELECT s.source_count,
              COUNT(source.episode_id) AS linked_count,
              SUM(CASE
                    WHEN e.status = 'active'
                     AND m.status = 'active'
                     AND i.status = 'active'
                     AND m.source = 'conversation_episode'
                     AND i.current_version_id IS NOT NULL
                    THEN 1 ELSE 0
                  END) AS valid_count
       FROM conversation_memory_summaries s
       LEFT JOIN conversation_memory_summary_sources source
         ON source.summary_id = s.id
       LEFT JOIN conversation_episodes e ON e.id = source.episode_id
       LEFT JOIN memories m ON m.id = e.memory_id
       LEFT JOIN memory_items i ON i.id = m.id
       WHERE s.id = ?
       GROUP BY s.id`,
    ).get(summaryId) as DatabaseRow | undefined;
    return Boolean(
      row &&
      Number(row.source_count) > 0 &&
      Number(row.source_count) === Number(row.linked_count) &&
      Number(row.source_count) === Number(row.valid_count),
    );
  }

  private summarySentenceCount(memoryId: string): number {
    return Number(this.database.prepare(
      `SELECT COUNT(DISTINCT source_ref) AS count
       FROM memory_evidence e
       JOIN memory_items i ON i.current_version_id = e.memory_version_id
       WHERE i.id = ?
         AND e.evidence_type = 'hierarchical_summary_sentence'`,
    ).get(memoryId)?.count || 0);
  }

  private insertSentenceEvidence(
    memoryVersionId: string,
    summaryId: string,
    sources: EpisodeSource[],
    sentences: ConsolidationSentence[],
    timestamp: string,
  ): void {
    const sourceByVersion = new Map(
      sources.map((source) => [source.memoryVersionId, source]),
    );
    const insert = this.database.prepare(
      `INSERT INTO memory_evidence (
         id, memory_version_id, turn_id, evidence_type, excerpt,
         source_ref, sensitivity, source_authority, created_at
       ) VALUES (?, ?, ?, 'hierarchical_summary_sentence', NULL,
                 ?, 'normal', 'imported', ?)`,
    );
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      for (const sourceVersionId of sentence.sourceVersionIds) {
        const source = sourceByVersion.get(sourceVersionId);
        if (!source) {
          throw new Error('层级摘要逐句来源不在当前 episode 集合中');
        }
        insert.run(
          randomUUID(),
          memoryVersionId,
          source.userTurnId,
          [
            'hierarchical-summary',
            summaryId,
            `sentence:${sentenceIndex}`,
            `episode:${source.episodeId}`,
            `version:${source.memoryVersionId}`,
          ].join(':'),
          timestamp,
        );
      }
    }
  }

  private invalidateSummary(
    summary: DatabaseRow,
    reason: 'source_invalid',
    ownTransaction = true,
  ): void {
    const persist = (): void => {
      const timestamp = new Date().toISOString();
      const memoryId = text(summary.memory_id);
      this.database.prepare(
        `UPDATE conversation_memory_summaries
         SET status = 'quarantined', updated_at = ?
         WHERE id = ? AND status = 'active'`,
      ).run(timestamp, text(summary.id));
      this.database.prepare(
        `UPDATE memories
         SET status = 'archived', updated_at = ?
         WHERE id = ? AND status = 'active'`,
      ).run(timestamp, memoryId);
      this.database.prepare(
        `UPDATE memory_items
         SET status = 'archived', archived_at = ?, archive_reason = ?,
             updated_at = ?
         WHERE id = ? AND status = 'active'`,
      ).run(timestamp, reason, timestamp, memoryId);
      for (const [table, column] of [
        ['memory_embeddings', 'memory_id'],
        ['memory_ann_index', 'memory_id'],
        ['memory_term_index', 'memory_id'],
        ['memory_dense_lsh', 'memory_id'],
        ['memories_fts', 'memory_id'],
      ] as const) {
        this.database.prepare(
          `DELETE FROM ${table} WHERE ${column} = ?`,
        ).run(memoryId);
      }
    };
    if (ownTransaction) {
      withMemoryStoreTransaction(this.database, persist);
    } else {
      persist();
    }
  }
}
