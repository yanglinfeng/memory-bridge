import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryKind, MemoryScopeType } from './types.js';

type DatabaseRow = Record<string, unknown>;
const MINIMUM_CONTRADICTION_RECOVERY_SUPPORTS = 3;

export type PatternObservationState =
  | 'supporting'
  | 'contradicting'
  | 'superseded'
  | 'blocked';

export interface PatternClaimIdentity {
  userId: string;
  namespace: string;
  scopeType: MemoryScopeType;
  scopeKey: string;
  claimFingerprint: string;
  kind: MemoryKind;
  subject: string;
  predicate: string;
  value: string;
  negated: boolean;
}

export interface PatternObservationInput extends PatternClaimIdentity {
  turnId: string;
  excerpt: string;
  runId: string | null;
  state: PatternObservationState;
  timestamp: string;
}

export interface PatternObservationEvidence {
  id: string;
  turnId: string;
  sessionId: string;
  excerpt: string;
  occurredAt: string;
}

export interface PatternEvidenceDiversityOptions {
  requireCrossSession?: boolean;
  requireCrossDay?: boolean;
  timezoneOffsetMinutes?: number;
}

export type PatternVerificationDeferralReason =
  | 'permanently_blocked'
  | 'insufficient_total_support'
  | 'insufficient_post_contradiction_support'
  | 'insufficient_diverse_support';

export interface PatternVerificationReadiness {
  evidence: PatternObservationEvidence[];
  reasonCode: PatternVerificationDeferralReason | null;
  supportingTurnCount: number;
  requiredTurnCount: number;
  latestContradictionAt: string | null;
  latestContradictionTurnId: string | null;
}

type PatternObservationScope = Pick<
  PatternClaimIdentity,
  'userId' | 'namespace' | 'scopeType' | 'scopeKey'
>;

function text(value: unknown, maximum = 1_000): string {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC').trim();
  return normalized.length <= maximum ? normalized : '';
}

function exactText(value: unknown, maximum = 2_000): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : '';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class PatternObservationStore {
  constructor(private readonly database: DatabaseSync) {}

  observe(input: PatternObservationInput): void {
    const owner = text(input.userId, 255);
    const namespace = text(input.namespace, 255);
    const scopeKey = text(input.scopeKey, 500);
    const fingerprint = text(input.claimFingerprint, 128);
    // Evidence is an exact quote. Normalizing it would change full-width
    // punctuation (for example `：` to `:`) and make a valid quote fail the
    // ownership check against the immutable source turn.
    const excerpt = exactText(input.excerpt, 2_000);
    const runId = input.runId === null ? null : text(input.runId, 255);
    const timestamp = text(input.timestamp, 64);
    if (
      !owner || !namespace || !scopeKey || !fingerprint || !excerpt ||
      !timestamp ||
      !['personal', 'project', 'role', 'session'].includes(input.scopeType) ||
      !['supporting', 'contradicting', 'superseded', 'blocked']
        .includes(input.state)
    ) {
      throw new Error('pattern observation 输入无效');
    }
    const turn = this.database.prepare(
      `SELECT t.id, t.session_id, t.content, t.occurred_at,
              t.user_id, t.namespace, s.persona_id, s.project_id,
              s.external_id AS session_external_id
       FROM conversation_turns t
       JOIN conversation_sessions s ON s.id = t.session_id
       WHERE t.id = ? AND t.role = 'user'`,
    ).get(text(input.turnId, 255)) as DatabaseRow | undefined;
    if (
      !turn || String(turn.user_id) !== owner ||
      String(turn.namespace) !== namespace ||
      !String(turn.content).includes(excerpt) ||
      !this.matchesScope(turn, input.scopeType, scopeKey)
    ) {
      throw new Error('pattern observation turn 所有权、scope 或证据不一致');
    }
    const existing = this.database.prepare(
      `SELECT id, observation_state
       FROM memory_pattern_observations
       WHERE user_id = ? AND namespace = ? AND scope_type = ?
         AND scope_key = ? AND claim_fingerprint = ? AND turn_id = ?`,
    ).get(
      owner,
      namespace,
      input.scopeType,
      scopeKey,
      fingerprint,
      input.turnId,
    ) as DatabaseRow | undefined;
    const nextState = this.strongerState(
      existing ? String(existing.observation_state) as PatternObservationState
        : null,
      input.state,
    );
    this.database.prepare(
      `INSERT INTO memory_pattern_observations (
         id, user_id, namespace, scope_type, scope_key,
         claim_fingerprint, kind, subject, predicate, value_text,
         negated, turn_id, session_id, excerpt, excerpt_hash,
         occurred_at, observation_state, first_run_id, last_run_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(
         user_id, namespace, scope_type, scope_key,
         claim_fingerprint, turn_id
       ) DO UPDATE SET
         observation_state = excluded.observation_state,
         last_run_id = excluded.last_run_id,
         updated_at = excluded.updated_at`,
    ).run(
      existing ? String(existing.id) : randomUUID(),
      owner,
      namespace,
      input.scopeType,
      scopeKey,
      fingerprint,
      input.kind,
      text(input.subject, 120),
      text(input.predicate, 120),
      text(input.value, 500),
      input.negated ? 1 : 0,
      input.turnId,
      String(turn.session_id),
      excerpt,
      sha256(excerpt),
      String(turn.occurred_at),
      nextState,
      runId,
      runId,
      timestamp,
      timestamp,
    );
  }

  clusterBlocked(input: PatternClaimIdentity): boolean {
    if (this.permanentlyBlocked(input)) return true;

    const barrier = this.latestContradiction(input);
    if (!barrier) return false;
    return this.supportingTurnCount(input, barrier) <
      MINIMUM_CONTRADICTION_RECOVERY_SUPPORTS;
  }

  verificationReadiness(
    input: PatternClaimIdentity,
    minimum = 3,
    maximum = 5,
    diversity: PatternEvidenceDiversityOptions = {},
  ): PatternVerificationReadiness {
    const requiredTurnCount = Math.max(1, Math.trunc(minimum));
    const barrier = this.latestContradiction(input);
    const supportingTurnCount = this.supportingTurnCount(input, barrier);
    const base = {
      supportingTurnCount,
      requiredTurnCount,
      latestContradictionAt: barrier?.occurredAt || null,
      latestContradictionTurnId: barrier?.turnId || null,
    };
    if (this.permanentlyBlocked(input)) {
      return {
        ...base,
        evidence: [],
        reasonCode: 'permanently_blocked',
      };
    }
    if (supportingTurnCount < requiredTurnCount) {
      return {
        ...base,
        evidence: [],
        reasonCode: barrier
          ? 'insufficient_post_contradiction_support'
          : 'insufficient_total_support',
      };
    }
    const evidence = this.evidenceForVerification(
      input,
      minimum,
      maximum,
      diversity,
    );
    return evidence.length > 0
      ? { ...base, evidence, reasonCode: null }
      : {
          ...base,
          evidence: [],
          reasonCode: 'insufficient_diverse_support',
        };
  }

  stableHabitClaims(scope: PatternObservationScope): PatternClaimIdentity[] {
    const rows = this.database.prepare(
      `SELECT claim_fingerprint, kind, subject, predicate, value_text
       FROM memory_pattern_observations o
       WHERE o.user_id = ? AND o.namespace = ? AND o.scope_type = ?
         AND o.scope_key = ? AND o.subject = '用户'
         AND o.predicate = '稳定生活习惯'
         AND o.observation_state != 'blocked'
         AND NOT EXISTS (
           SELECT 1 FROM memory_pattern_observations blocked_observation
           WHERE blocked_observation.user_id = o.user_id
             AND blocked_observation.namespace = o.namespace
             AND blocked_observation.scope_type = o.scope_type
             AND blocked_observation.scope_key = o.scope_key
             AND blocked_observation.claim_fingerprint = o.claim_fingerprint
             AND blocked_observation.observation_state = 'blocked'
         )
         AND NOT EXISTS (
           SELECT 1 FROM memory_reflection_claims c
           WHERE c.user_id = o.user_id AND c.namespace = o.namespace
             AND c.scope_type = o.scope_type AND c.scope_key = o.scope_key
             AND c.claim_fingerprint = o.claim_fingerprint
             AND c.decision IN ('rejected', 'blocked')
         )
       GROUP BY o.claim_fingerprint, o.kind, o.subject, o.predicate, o.value_text
       ORDER BY MIN(o.occurred_at) ASC, o.claim_fingerprint ASC`,
    ).all(
      text(scope.userId, 255),
      text(scope.namespace, 255),
      scope.scopeType,
      text(scope.scopeKey, 500),
    ) as DatabaseRow[];
    return rows.map((row) => ({
      userId: text(scope.userId, 255),
      namespace: text(scope.namespace, 255),
      scopeType: scope.scopeType,
      scopeKey: text(scope.scopeKey, 500),
      claimFingerprint: String(row.claim_fingerprint),
      kind: String(row.kind) as MemoryKind,
      subject: String(row.subject),
      predicate: String(row.predicate),
      value: String(row.value_text),
      negated: false,
    }));
  }

  evidenceForVerification(
    input: PatternClaimIdentity,
    minimum = 3,
    maximum = 5,
    diversity: PatternEvidenceDiversityOptions = {},
  ): PatternObservationEvidence[] {
    if (this.clusterBlocked(input)) return [];
    const limit = Math.max(minimum, Math.min(5, Math.trunc(maximum)));
    const identity = [
      text(input.userId, 255),
      text(input.namespace, 255),
      input.scopeType,
      text(input.scopeKey, 500),
      text(input.claimFingerprint, 128),
    ] as const;
    const barrier = this.latestContradiction(input);
    const barrierFilter = barrier
      ? `AND (
           occurred_at > ? OR (occurred_at = ? AND turn_id > ?)
         )`
      : '';
    const parameters: Array<string> = barrier
      ? [
          ...identity,
          barrier.occurredAt,
          barrier.occurredAt,
          barrier.turnId,
        ]
      : [...identity];
    const select = `SELECT id, turn_id, session_id, excerpt, occurred_at
                    FROM memory_pattern_observations
                    WHERE user_id = ? AND namespace = ? AND scope_type = ?
                      AND scope_key = ? AND claim_fingerprint = ?
                      AND observation_state = 'supporting'
                      ${barrierFilter}`;
    const baseRows = this.database.prepare(
      `${select}
       ORDER BY occurred_at ASC, turn_id ASC
       LIMIT ?`,
    ).all(
      ...parameters,
      limit,
    ) as DatabaseRow[];
    if (new Set(baseRows.map((row) => String(row.turn_id))).size < minimum) {
      return [];
    }
    const requireCrossSession = Boolean(diversity.requireCrossSession);
    const requireCrossDay = Boolean(diversity.requireCrossDay);
    let selectedRows = baseRows;
    if (requireCrossSession || requireCrossDay) {
      const pool = new Map(baseRows.map((row) => [String(row.id), row]));
      if (requireCrossSession) {
        const rows = this.database.prepare(
          `WITH ranked AS (
             SELECT id, turn_id, session_id, excerpt, occurred_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_id
                      ORDER BY occurred_at ASC, turn_id ASC
                    ) AS ordinal
             FROM (${select})
           )
           SELECT id, turn_id, session_id, excerpt, occurred_at
           FROM ranked WHERE ordinal = 1
           ORDER BY occurred_at ASC, turn_id ASC
           LIMIT ?`,
        ).all(...parameters, limit) as DatabaseRow[];
        for (const row of rows) pool.set(String(row.id), row);
      }
      if (requireCrossDay) {
        const offset = Number.isInteger(diversity.timezoneOffsetMinutes)
          ? Number(diversity.timezoneOffsetMinutes)
          : 0;
        const rows = this.database.prepare(
          `WITH ranked AS (
             SELECT id, turn_id, session_id, excerpt, occurred_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY date(
                        occurred_at,
                        printf('%+d minutes', ?)
                      )
                      ORDER BY occurred_at ASC, turn_id ASC
                    ) AS ordinal
             FROM (${select})
           )
           SELECT id, turn_id, session_id, excerpt, occurred_at
           FROM ranked WHERE ordinal = 1
           ORDER BY occurred_at ASC, turn_id ASC
           LIMIT ?`,
        ).all(offset, ...parameters, limit) as DatabaseRow[];
        for (const row of rows) pool.set(String(row.id), row);
      }
      const candidates = [...pool.values()].sort((left, right) =>
        String(left.occurred_at).localeCompare(String(right.occurred_at)) ||
        String(left.turn_id).localeCompare(String(right.turn_id))
      );
      selectedRows = this.selectDiverseRows(
        candidates,
        minimum,
        limit,
        diversity,
      );
      if (selectedRows.length === 0) return [];
    }
    return selectedRows.map((row) => ({
      id: String(row.id),
      turnId: String(row.turn_id),
      sessionId: String(row.session_id),
      excerpt: String(row.excerpt),
      occurredAt: String(row.occurred_at),
    }));
  }

  private selectDiverseRows(
    rows: DatabaseRow[],
    minimum: number,
    maximum: number,
    options: PatternEvidenceDiversityOptions,
  ): DatabaseRow[] {
    const offset = Number.isInteger(options.timezoneOffsetMinutes)
      ? Number(options.timezoneOffsetMinutes)
      : 0;
    const day = (row: DatabaseRow): string => new Date(
      Date.parse(String(row.occurred_at)) + offset * 60_000,
    ).toISOString().slice(0, 10);
    const valid = (candidate: DatabaseRow[]): boolean =>
      (!options.requireCrossSession ||
        new Set(candidate.map((row) => String(row.session_id))).size >= 2) &&
      (!options.requireCrossDay ||
        new Set(candidate.map(day)).size >= 2);
    const choose = (
      target: number,
      start: number,
      selected: DatabaseRow[],
    ): DatabaseRow[] | null => {
      if (selected.length === target) {
        return valid(selected) ? selected : null;
      }
      for (let index = start;
        index <= rows.length - (target - selected.length);
        index += 1) {
        const result = choose(target, index + 1, [...selected, rows[index]!]);
        if (result) return result;
      }
      return null;
    };
    for (let size = minimum; size <= Math.min(maximum, rows.length); size += 1) {
      const selected = choose(size, 0, []);
      if (selected) return selected;
    }
    return [];
  }

  private latestContradiction(
    input: PatternClaimIdentity,
  ): { occurredAt: string; turnId: string } | null {
    const row = this.database.prepare(
      `SELECT occurred_at, turn_id
       FROM memory_pattern_observations
       WHERE user_id = ? AND namespace = ? AND scope_type = ?
         AND scope_key = ? AND claim_fingerprint = ?
         AND observation_state = 'contradicting'
       ORDER BY occurred_at DESC, turn_id DESC
       LIMIT 1`,
    ).get(
      text(input.userId, 255),
      text(input.namespace, 255),
      input.scopeType,
      text(input.scopeKey, 500),
      text(input.claimFingerprint, 128),
    ) as DatabaseRow | undefined;
    return row
      ? { occurredAt: String(row.occurred_at), turnId: String(row.turn_id) }
      : null;
  }

  private permanentlyBlocked(input: PatternClaimIdentity): boolean {
    const identity = [
      text(input.userId, 255),
      text(input.namespace, 255),
      input.scopeType,
      text(input.scopeKey, 500),
      text(input.claimFingerprint, 128),
    ] as const;
    const observationBlocked = this.database.prepare(
      `SELECT 1
       FROM memory_pattern_observations
       WHERE user_id = ? AND namespace = ? AND scope_type = ?
         AND scope_key = ? AND claim_fingerprint = ?
         AND observation_state = 'blocked'
       LIMIT 1`,
    ).get(...identity);
    if (observationBlocked) return true;
    return Boolean(this.database.prepare(
      `SELECT 1
       FROM memory_reflection_claims
       WHERE user_id = ? AND namespace = ? AND scope_type = ?
         AND scope_key = ? AND claim_fingerprint = ?
         AND decision IN ('rejected', 'blocked')
       LIMIT 1`,
    ).get(...identity));
  }

  private supportingTurnCount(
    input: PatternClaimIdentity,
    barrier: { occurredAt: string; turnId: string } | null,
  ): number {
    const barrierFilter = barrier
      ? `AND (
           occurred_at > ? OR (occurred_at = ? AND turn_id > ?)
         )`
      : '';
    const values: string[] = [
      text(input.userId, 255),
      text(input.namespace, 255),
      input.scopeType,
      text(input.scopeKey, 500),
      text(input.claimFingerprint, 128),
    ];
    if (barrier) {
      values.push(barrier.occurredAt, barrier.occurredAt, barrier.turnId);
    }
    const row = this.database.prepare(
      `SELECT COUNT(DISTINCT turn_id) AS count
       FROM memory_pattern_observations
       WHERE user_id = ? AND namespace = ? AND scope_type = ?
         AND scope_key = ? AND claim_fingerprint = ?
         AND observation_state = 'supporting'
         ${barrierFilter}`,
    ).get(...values) as DatabaseRow | undefined;
    return Number(row?.count || 0);
  }

  private matchesScope(
    row: DatabaseRow,
    scopeType: MemoryScopeType,
    scopeKey: string,
  ): boolean {
    if (scopeType === 'personal') return scopeKey === 'self';
    if (scopeType === 'project') return String(row.project_id ?? '') === scopeKey;
    if (scopeType === 'role') return String(row.persona_id ?? '') === scopeKey;
    return String(row.session_external_id ?? '') === scopeKey;
  }

  private strongerState(
    current: PatternObservationState | null,
    incoming: PatternObservationState,
  ): PatternObservationState {
    const priority: Readonly<Record<PatternObservationState, number>> = {
      supporting: 0,
      superseded: 1,
      contradicting: 2,
      blocked: 3,
    };
    return current && priority[current] > priority[incoming]
      ? current
      : incoming;
  }
}
