import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import type { MemoryAccessScope } from './types.js';

type DatabaseRow = Record<string, unknown>;

export type RetrievalTraceStage =
  | 'request'
  | 'rewrite'
  | 'channels'
  | 'fusion'
  | 'semantic'
  | 'rerank'
  | 'selection'
  | 'context'
  | 'result';

export type RetrievalQualityState =
  | 'full'
  | 'degraded'
  | 'unavailable';

export interface RetrievalTraceEvent {
  sequence: number;
  stage: RetrievalTraceStage;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface RetrievalTraceSummary {
  traceId: string;
  userId: string;
  namespace: string;
  scopes: MemoryAccessScope[];
  logMode: 'metadata' | 'diagnostic';
  queryHash: string;
  query: string | null;
  request: Record<string, unknown>;
  qualityState: RetrievalQualityState | null;
  resultCount: number;
  totalDurationMs: number | null;
  errorCode: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface RetrievalTraceDetail extends RetrievalTraceSummary {
  events: RetrievalTraceEvent[];
}

export interface RetrievalLogHealth {
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
}

interface TraceStartInput {
  userId: string;
  namespace: string;
  query: string;
  scopes: MemoryAccessScope[];
  request?: Record<string, unknown>;
}

interface TraceFinishInput {
  qualityState: RetrievalQualityState;
  resultCount: number;
  errorCode?: string | null;
  detail?: Record<string, unknown>;
}

function now(): string {
  return new Date().toISOString();
}

function queryDigest(value: string): string {
  return createHash('sha256')
    .update(value.normalize('NFKC').trim())
    .digest('hex');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = asText(value).trim();
  return text || null;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseScopes(value: unknown): MemoryAccessScope[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const candidate = entry as Record<string, unknown>;
      const scopeType = asText(candidate.scopeType);
      const scopeKey = asText(candidate.scopeKey).trim();
      if (
        !['personal', 'project', 'role', 'session'].includes(scopeType) ||
        !scopeKey
      ) return [];
      return [{
        scopeType: scopeType as MemoryAccessScope['scopeType'],
        scopeKey,
      }];
    });
  } catch {
    return [];
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
      '$1=[REDACTED]',
    );
}

function safeDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(safeDiagnosticValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, entry]) => [key, safeDiagnosticValue(entry)],
      ),
    );
  }
  return value;
}

function isFreeTextErrorKey(key: string): boolean {
  const normalized = key.replaceAll('_', '').toLowerCase();
  if (
    normalized.endsWith('errorcode') ||
    normalized.endsWith('errorhash')
  ) return false;
  return normalized.includes('error') ||
    normalized.endsWith('failurereason');
}

function isSecretFieldKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/gu, '').toLowerCase();
  return new Set([
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'secret',
    'clientsecret',
    'password',
    'passwd',
    'pwd',
    'apikey',
    'credential',
    'credentials',
    'authorization',
    'cookie',
    'setcookie',
  ]).has(normalized);
}

export function sanitizeAuditDetail(
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const sanitizeObject = (
    value: Record<string, unknown>,
  ): Record<string, unknown> => Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (isSecretFieldKey(key)) return [key, '[REDACTED]'];
      if (isFreeTextErrorKey(key) && typeof entry === 'string') {
        return [`${key}Hash`, queryDigest(entry)];
      }
      if (Array.isArray(entry)) {
        return [key, entry.map((item) => {
          if (item && typeof item === 'object') {
            return sanitizeObject(item as Record<string, unknown>);
          }
          return safeDiagnosticValue(item);
        })];
      }
      if (entry && typeof entry === 'object') {
        return [key, sanitizeObject(entry as Record<string, unknown>)];
      }
      return [key, safeDiagnosticValue(entry)];
    }),
  );
  return sanitizeObject(detail);
}

function traceFromRow(row: DatabaseRow): RetrievalTraceSummary {
  const quality = asNullableText(row.quality_state);
  return {
    traceId: asText(row.trace_id),
    userId: asText(row.user_id),
    namespace: asText(row.namespace),
    scopes: parseScopes(row.scope_summary_json),
    logMode: asText(row.log_mode) === 'diagnostic'
      ? 'diagnostic'
      : 'metadata',
    queryHash: asText(row.query_hash),
    query: asNullableText(row.query_text),
    request: parseObject(row.request_json),
    qualityState:
      quality === 'full' ||
      quality === 'degraded' ||
      quality === 'unavailable'
        ? quality
        : null,
    resultCount: Number(row.result_count) || 0,
    totalDurationMs:
      row.total_duration_ms === null || row.total_duration_ms === undefined
        ? null
        : Number(row.total_duration_ms),
    errorCode: asNullableText(row.error_code),
    startedAt: asText(row.started_at),
    completedAt: asNullableText(row.completed_at),
  };
}

export class RetrievalTraceSession {
  readonly traceId = randomUUID();
  readonly queryHash: string;
  private readonly startedAt = now();
  private readonly startedNs = process.hrtime.bigint();
  private lastEventNs = this.startedNs;
  private sequence = 0;
  private completed = false;
  private attempt = 1;
  private attemptReason = 'initial';
  private readonly stagesByAttempt = new Map<
    number,
    Set<RetrievalTraceStage>
  >();

  constructor(
    private readonly writer: RetrievalObservability,
    readonly input: TraceStartInput,
  ) {
    this.queryHash = queryDigest(input.query);
    this.writer.start(this);
  }

  event(
    stage: RetrievalTraceStage,
    detail: Record<string, unknown>,
  ): void {
    if (this.completed) return;
    const eventNs = process.hrtime.bigint();
    const durationMs = Number(
      (Number(eventNs - this.lastEventNs) / 1_000_000).toFixed(3),
    );
    this.lastEventNs = eventNs;
    this.sequence += 1;
    this.stagesForCurrentAttempt().add(stage);
    this.writer.event(this, this.sequence, stage, {
      ...detail,
      attempt: this.attempt,
      attemptReason: this.attemptReason,
      durationMs,
    });
  }

  beginAttempt(reason: string): void {
    if (this.completed) return;
    this.attempt += 1;
    this.attemptReason = reason;
  }

  completeFailedStages(
    errorCode: string,
    errorMessage: string,
    contextDetail: Record<string, unknown> = {},
    failureDetail: Record<string, unknown> = {},
  ): RetrievalTraceStage {
    const stages: RetrievalTraceStage[] = [
      'rewrite',
      'channels',
      'fusion',
      'semantic',
      'rerank',
      'selection',
      'context',
    ];
    const emitted = this.stagesForCurrentAttempt();
    const failedStage = stages.find((stage) => !emitted.has(stage)) ||
      'context';
    let failureRecorded = emitted.has(failedStage);
    for (const stage of stages) {
      if (emitted.has(stage)) continue;
      const isFailedStage = !failureRecorded;
      this.event(stage, {
        ...this.emptyStageDetail(stage),
        ...(stage === 'context' ? contextDetail : {}),
        ...(isFailedStage ? failureDetail : {}),
        skipped: !isFailedStage,
        reason: isFailedStage
          ? 'stage_failed'
          : 'upstream_stage_failed',
        failedStage,
        errorCode,
        error: errorMessage,
      });
      failureRecorded = true;
    }
    return failedStage;
  }

  finish(input: TraceFinishInput): void {
    if (this.completed) return;
    const completedNs = process.hrtime.bigint();
    const totalDurationMs = Number(
      (Number(completedNs - this.startedNs) / 1_000_000)
        .toFixed(3),
    );
    const durationMs = Number(
      (Number(completedNs - this.lastEventNs) / 1_000_000).toFixed(3),
    );
    this.completed = true;
    this.sequence += 1;
    this.writer.finish(
      this,
      this.sequence,
      {
        ...input,
        detail: {
          ...(input.detail || {}),
          attempt: this.attempt,
          attemptReason: this.attemptReason,
          durationMs,
        },
      },
      totalDurationMs,
    );
  }

  startTime(): string {
    return this.startedAt;
  }

  private stagesForCurrentAttempt(): Set<RetrievalTraceStage> {
    const existing = this.stagesByAttempt.get(this.attempt);
    if (existing) return existing;
    const created = new Set<RetrievalTraceStage>();
    this.stagesByAttempt.set(this.attempt, created);
    return created;
  }

  private emptyStageDetail(
    stage: RetrievalTraceStage,
  ): Record<string, unknown> {
    if (stage === 'rewrite') return { variants: [] };
    if (stage === 'channels') {
      return { queryVariantCount: 0, candidateCountByVariant: [] };
    }
    if (stage === 'fusion') return { candidateCount: 0, candidates: [] };
    if (stage === 'semantic') return { candidateCount: 0 };
    if (stage === 'rerank') {
      return { stages: [], attemptedCandidates: 0, decisions: [] };
    }
    if (stage === 'selection') {
      return { resultIds: [], candidateDecisions: [] };
    }
    if (stage === 'context') {
      return {
        injectedMemoryIds: [],
        actualTokens: 0,
        groundingState: 'unavailable',
      };
    }
    return {};
  }
}

export class RetrievalObservability {
  private readonly jsonlPath: string;
  private readonly pendingJsonl = new Map<
    string,
    { userId: string; payloads: Record<string, unknown>[] }
  >();
  private lastCleanupDate = '';
  private lastDatabaseError: string | null = null;
  private lastDatabaseFailureAt: string | null = null;
  private totalDatabaseFailures = 0;
  private lastJsonlError: string | null = null;

  constructor(private readonly database: DatabaseSync) {
    const main = (
      database.prepare('PRAGMA database_list').all() as DatabaseRow[]
    ).find((row) => asText(row.name) === 'main');
    const databaseFile = main ? asNullableText(main.file) : null;
    this.jsonlPath = config.retrievalJsonlPath || path.join(
      databaseFile ? path.dirname(databaseFile) : config.dataDir,
      'logs',
      'retrieval.jsonl',
    );
  }

  createTrace(input: TraceStartInput): RetrievalTraceSession {
    return new RetrievalTraceSession(this, input);
  }

  start(trace: RetrievalTraceSession): void {
    const diagnostic = config.retrievalLogMode === 'diagnostic';
    const request = diagnostic
      ? safeDiagnosticValue(trace.input.request || {})
      : trace.input.request || {};
    this.bestEffortDatabase(() => {
      this.database
        .prepare(
          `INSERT INTO retrieval_traces (
             trace_id, user_id, namespace, scope_summary_json,
             log_mode, query_hash, query_text, request_json,
             started_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trace.traceId,
          trace.input.userId,
          trace.input.namespace,
          JSON.stringify(trace.input.scopes),
          config.retrievalLogMode,
          trace.queryHash,
          diagnostic
            ? redactSensitiveText(trace.input.query)
            : null,
          JSON.stringify(request),
          trace.startTime(),
        );
    });
    trace.event('request', {
      queryHash: trace.queryHash,
      query: diagnostic
        ? redactSensitiveText(trace.input.query)
        : undefined,
      namespace: trace.input.namespace,
      scopes: trace.input.scopes,
      ...trace.input.request,
    });
  }

  event(
    trace: RetrievalTraceSession,
    sequence: number,
    stage: RetrievalTraceStage,
    detail: Record<string, unknown>,
  ): void {
    const safeDetail = config.retrievalLogMode === 'diagnostic'
      ? safeDiagnosticValue(detail) as Record<string, unknown>
      : this.metadataOnlyDetail(detail);
    const createdAt = now();
    this.bestEffortDatabase(() => {
      this.database
        .prepare(
          `INSERT INTO retrieval_trace_events (
             trace_id, sequence, stage, event_json, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          trace.traceId,
          sequence,
          stage,
          JSON.stringify(safeDetail),
          createdAt,
        );
    });
    this.queueJsonl(trace, {
      traceId: trace.traceId,
      sequence,
      stage,
      createdAt,
      detail: safeDetail,
    });
  }

  finish(
    trace: RetrievalTraceSession,
    sequence: number,
    input: TraceFinishInput,
    totalDurationMs: number,
  ): void {
    const completedAt = now();
    this.bestEffortDatabase(() => {
      this.database
        .prepare(
          `UPDATE retrieval_traces
           SET quality_state = ?, result_count = ?, total_duration_ms = ?,
               error_code = ?, completed_at = ?
           WHERE trace_id = ? AND user_id = ?`,
        )
        .run(
          input.qualityState,
          Math.max(0, Math.trunc(input.resultCount)),
          totalDurationMs,
          input.errorCode || null,
          completedAt,
          trace.traceId,
          trace.input.userId,
        );
    });
    this.event(trace, sequence, 'result', {
      qualityState: input.qualityState,
      resultCount: Math.max(0, Math.trunc(input.resultCount)),
      totalDurationMs,
      errorCode: input.errorCode || null,
      ...(input.detail || {}),
    });
    this.flushJsonl(trace.traceId);
  }

  list(
    userId: string,
    input: {
      namespace?: string;
      qualityState?: RetrievalQualityState;
      resultId?: string;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): RetrievalTraceSummary[] {
    const clauses = ['t.user_id = ?'];
    const values: Array<string | number> = [userId];
    if (input.namespace) {
      clauses.push('t.namespace = ?');
      values.push(input.namespace);
    }
    if (input.qualityState) {
      clauses.push('t.quality_state = ?');
      values.push(input.qualityState);
    }
    if (input.since) {
      clauses.push('t.started_at >= ?');
      values.push(input.since);
    }
    if (input.until) {
      clauses.push('t.started_at <= ?');
      values.push(input.until);
    }
    if (input.resultId) {
      clauses.push(
        `EXISTS (
           SELECT 1
           FROM retrieval_trace_events e
           WHERE e.trace_id = t.trace_id
             AND e.stage IN ('selection', 'context', 'result')
             AND e.event_json LIKE ?
         )`,
      );
      values.push(`%${input.resultId.replaceAll('%', '\\%')}%`);
    }
    values.push(
      Math.max(1, Math.min(input.limit || 100, 500)),
      Math.max(0, Math.trunc(input.offset || 0)),
    );
    return (
      this.database
        .prepare(
          `SELECT t.*
           FROM retrieval_traces t
           WHERE ${clauses.join(' AND ')}
           ORDER BY t.started_at DESC, t.trace_id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...values) as DatabaseRow[]
    ).map(traceFromRow);
  }

  get(traceId: string, userId: string): RetrievalTraceDetail | null {
    const row = this.database
      .prepare(
        `SELECT *
         FROM retrieval_traces
         WHERE trace_id = ? AND user_id = ?`,
      )
      .get(traceId, userId) as DatabaseRow | undefined;
    if (!row) return null;
    const events = (
      this.database
        .prepare(
          `SELECT sequence, stage, event_json, created_at
           FROM retrieval_trace_events
           WHERE trace_id = ?
           ORDER BY sequence ASC`,
        )
        .all(traceId) as DatabaseRow[]
    ).map((event): RetrievalTraceEvent => ({
      sequence: Number(event.sequence),
      stage: asText(event.stage) as RetrievalTraceStage,
      detail: parseObject(event.event_json),
      createdAt: asText(event.created_at),
    }));
    return { ...traceFromRow(row), events };
  }

  health(userId: string): RetrievalLogHealth {
    const row = this.database
      .prepare(
        `SELECT *
         FROM retrieval_log_state
         WHERE user_id = ?`,
      )
      .get(userId) as DatabaseRow | undefined;
    return {
      logMode: config.retrievalLogMode,
      jsonlEnabled: config.retrievalJsonlEnabled,
      jsonlPath: this.jsonlPath,
      retentionDays: config.retrievalLogRetentionDays,
      maxBytes: config.retrievalLogMaxBytes,
      lastSuccessAt: row ? asNullableText(row.last_success_at) : null,
      lastFailureAt:
        this.lastDatabaseFailureAt ||
        (row ? asNullableText(row.last_failure_at) : null),
      consecutiveFailures:
        (row ? Number(row.consecutive_failures) || 0 : 0) +
        (this.lastDatabaseError ? 1 : 0),
      totalFailures:
        (row ? Number(row.total_failures) || 0 : 0) +
        this.totalDatabaseFailures,
      lastError:
        this.lastDatabaseError ||
        (row ? asNullableText(row.last_error) : null) ||
        this.lastJsonlError,
    };
  }

  prune(userId: string, before?: string): number {
    const cutoff = before || new Date(
      Date.now() - config.retrievalLogRetentionDays * 86_400_000,
    ).toISOString();
    const result = this.database
      .prepare(
        `DELETE FROM retrieval_traces
         WHERE user_id = ? AND started_at < ?`,
      )
      .run(userId, cutoff);
    this.cleanupJsonl(now().slice(0, 10));
    return Number(result.changes);
  }

  private metadataOnlyDetail(
    detail: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.metadataObject(detail, 0);
  }

  private metadataObject(
    detail: Record<string, unknown>,
    depth: number,
  ): Record<string, unknown> {
    const disallowed = new Set([
      'query',
      'queryText',
      'variantText',
      'standaloneQuery',
      'resolvedText',
      'clarificationQuestion',
      'memory',
      'content',
      'excerpt',
    ]);
    return Object.fromEntries(
      Object.entries(detail).flatMap(([key, value]) => {
        if (disallowed.has(key)) return [];
        if (key === 'error') {
          return [['errorHash', queryDigest(asText(value))]];
        }
        if (key === 'reason' && depth > 0) return [];
        if (key === 'reasons') return [];
        if (key === 'variants' && Array.isArray(value)) {
          return [[
            key,
            value.map((variant) => ({
              type:
                variant && typeof variant === 'object'
                  ? (variant as Record<string, unknown>).type
                  : 'unknown',
              hash: queryDigest(
                asText(
                  variant && typeof variant === 'object'
                    ? (variant as Record<string, unknown>).query
                    : variant,
                ),
              ),
            })),
          ]];
        }
        if (Array.isArray(value)) {
          return [[
            key,
            value.map((entry) => this.metadataValue(entry, depth + 1)),
          ]];
        }
        if (value && typeof value === 'object') {
          return [[
            key,
            this.metadataObject(
              value as Record<string, unknown>,
              depth + 1,
            ),
          ]];
        }
        return [[key, value]];
      }),
    );
  }

  private metadataValue(value: unknown, depth: number): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.metadataValue(entry, depth + 1));
    }
    if (value && typeof value === 'object') {
      return this.metadataObject(
        value as Record<string, unknown>,
        depth,
      );
    }
    return value;
  }

  private bestEffortDatabase(
    operation: () => void,
    resetsFailure = true,
  ): void {
    try {
      operation();
      if (resetsFailure) this.lastDatabaseError = null;
    } catch (error) {
      this.lastDatabaseError = error instanceof Error
        ? error.message
        : String(error);
      this.lastDatabaseFailureAt = now();
      this.totalDatabaseFailures += 1;
    }
  }

  private queueJsonl(
    trace: RetrievalTraceSession,
    payload: Record<string, unknown>,
  ): void {
    if (!config.retrievalJsonlEnabled) return;
    const pending = this.pendingJsonl.get(trace.traceId) || {
      userId: trace.input.userId,
      payloads: [],
    };
    pending.payloads.push(payload);
    this.pendingJsonl.set(trace.traceId, pending);
  }

  private flushJsonl(traceId: string): void {
    const pending = this.pendingJsonl.get(traceId);
    this.pendingJsonl.delete(traceId);
    if (
      !config.retrievalJsonlEnabled ||
      !pending ||
      pending.payloads.length === 0
    ) return;
    try {
      const target = this.activeJsonlPath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const lines = `${pending.payloads
        .map((payload) => JSON.stringify(payload))
        .join('\n')}\n`;
      if (
        fs.existsSync(target) &&
        fs.statSync(target).size + Buffer.byteLength(lines) >
          config.retrievalLogMaxBytes
      ) {
        const rotated = target.replace(
          /\.jsonl$/u,
          `.${Date.now()}.jsonl`,
        );
        fs.renameSync(target, rotated);
      }
      fs.appendFileSync(target, lines, { encoding: 'utf8', mode: 0o600 });
      this.lastJsonlError = null;
      this.recordJsonlSuccess(pending.userId, target);
      this.cleanupJsonl(now().slice(0, 10));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastJsonlError = message;
      this.recordJsonlFailure(pending.userId, message);
    }
  }

  private activeJsonlPath(): string {
    const date = now().slice(0, 10);
    return this.jsonlPath.replace(/\.jsonl$/u, `.${date}.jsonl`);
  }

  private cleanupJsonl(date: string): void {
    if (this.lastCleanupDate === date) return;
    this.lastCleanupDate = date;
    const directory = path.dirname(this.jsonlPath);
    if (!fs.existsSync(directory)) return;
    const prefix = `${path.basename(this.jsonlPath, '.jsonl')}.`;
    const cutoff = Date.now() - config.retrievalLogRetentionDays * 86_400_000;
    for (const name of fs.readdirSync(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue;
      const target = path.join(directory, name);
      if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
    }
  }

  private recordJsonlSuccess(userId: string, target: string): void {
    this.bestEffortDatabase(() => {
      this.database
        .prepare(
          `INSERT INTO retrieval_log_state (
             user_id, last_success_at, consecutive_failures, jsonl_path
           ) VALUES (?, ?, 0, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             last_success_at = excluded.last_success_at,
             consecutive_failures = 0,
             last_error = NULL,
             jsonl_path = excluded.jsonl_path`,
        )
        .run(userId, now(), target);
    }, false);
  }

  private recordJsonlFailure(userId: string, message: string): void {
    this.bestEffortDatabase(() => {
      this.database
        .prepare(
          `INSERT INTO retrieval_log_state (
             user_id, last_failure_at, consecutive_failures,
             total_failures, last_error, jsonl_path
           ) VALUES (?, ?, 1, 1, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             last_failure_at = excluded.last_failure_at,
             consecutive_failures =
               retrieval_log_state.consecutive_failures + 1,
             total_failures = retrieval_log_state.total_failures + 1,
             last_error = excluded.last_error,
             jsonl_path = excluded.jsonl_path`,
        )
        .run(userId, now(), message.slice(0, 2_000), this.jsonlPath);
    }, false);
  }
}

export function retrievalQueryHash(query: string): string {
  return queryDigest(query);
}
