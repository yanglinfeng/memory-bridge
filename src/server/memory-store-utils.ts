/**
 * 清洗/校验/遥测/键派生等基础工具函数（原 memory-store.ts 472-660、853-1067 行）。
 *
 * 由 memory-store.ts 机械搬迁而来（仅加 export 前缀），公开符号由门面 re-export。
 */

import type {
  CorpusDomain,
  MemoryClassification,
  MemoryRecord,
  RememberInput,
  UpdateMemoryInput,
} from './types.js';
import type { QueryUnderstandingResult } from './contextual-query-understanding.js';
import type { SemanticOperationTelemetry } from './semantic-ranker.js';
import { config } from './config.js';
import {
  canonicalContentHash,
  findBlockingTombstone,
} from './tombstone-policy.js';
import type { TombstoneClaimIdentity } from './tombstone-policy.js';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DatabaseRow,
  TombstoneWriteAuthorization,
} from './memory-store-types.js';

export function now(): string {
  return new Date().toISOString();
}

export function temporalRangesOverlap(
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

export function clamp(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function cleanText(value: string | undefined, fallback = ''): string {
  return (value || fallback).normalize('NFKC').trim();
}

export function normalizedRetrievalSignal(value: string | null | undefined): string {
  return cleanText(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase();
}

export function hasQualityFallbackQueryDelta(
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

export function queryUnderstandingTraceTelemetry(
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

export function semanticOperationTraceTelemetry(
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

export function legacySemanticOperationTelemetry(
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

export function aggregateSemanticOperationTraceTelemetry(
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

export function approximateTokenCount(value: string): number {
  return Math.max(
    1,
    [...value].filter((character) => !/\s/u.test(character)).length,
  );
}

export function truncateToTokenBudget(
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

export function cleanUserId(value: string | undefined): string {
  return cleanText(value, config.defaultUserId);
}

export function cleanScopeType(
  value: RememberInput['scopeType'] | UpdateMemoryInput['scopeType'],
  fallback: MemoryRecord['scopeType'] = 'personal',
): MemoryRecord['scopeType'] {
  return ['personal', 'project', 'role', 'session', 'public'].includes(
    value || '',
  )
    ? value as MemoryRecord['scopeType']
    : fallback;
}

export function cleanSensitivity(
  value: RememberInput['sensitivity'] | UpdateMemoryInput['sensitivity'],
  fallback: MemoryRecord['sensitivity'] = 'normal',
): MemoryRecord['sensitivity'] {
  return ['normal', 'sensitive', 'credential'].includes(value || '')
    ? value as MemoryRecord['sensitivity']
    : fallback;
}

export const SOURCE_AUTHORITY_RANK: Record<
  MemoryRecord['sourceAuthority'],
  number
> = {
  legacy_unknown: 0,
  assistant_inference: 1,
  imported: 2,
  user_confirmed: 3,
  direct_user: 4,
};

export function cleanSourceAuthority(
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

export function strongerSourceAuthority(
  current: MemoryRecord['sourceAuthority'],
  observed: MemoryRecord['sourceAuthority'],
): MemoryRecord['sourceAuthority'] {
  return SOURCE_AUTHORITY_RANK[observed] >
    SOURCE_AUTHORITY_RANK[current]
    ? observed
    : current;
}

export function cleanDate(
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

export function validateValidityWindow(
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

export function cleanTags(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values || [])
        .map((value) => cleanText(value).toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 30);
}

export function checksum(content: string): string {
  return canonicalContentHash(content);
}

export function stableKeyForCreate(
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

export function authorizedTombstoneId(
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

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function normalizeCorpusDomain(value: unknown): CorpusDomain | null {
  return value === 'policy' || value === 'open' || value === 'chat'
    ? value
    : null;
}

/**
 * 密级归一：非法值一律回落 internal（从严——写坏的字段不能放大可见范围）。
 * 恒返回具体值，与 v43 列默认值 internal 一致。
 */
export function normalizeClassification(value: unknown): MemoryClassification {
  return value === 'public' || value === 'confidential'
    ? value
    : 'internal';
}

