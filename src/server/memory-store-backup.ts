/**
 * 备份校验与 full-backup scope 授权（原 memory-store.ts 1929-4151 行）。
 *
 * 由 memory-store.ts 机械搬迁而来（仅加 export 前缀），公开符号由门面 re-export。
 */

import { memoryBackupSchema } from './memory-store-schemas.js';
import type {
  FullBackupState,
  MemoryBackup,
} from './memory-store-schemas.js';
import {
  checksum,
  validateValidityWindow,
} from './memory-store-utils.js';
import { createHash } from 'node:crypto';
import { isClientIdentityId } from './client-identity-contract.js';

export function validateBackup(
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

export function rowText(
  row: Record<string, string | number | null>,
  column: string,
): string {
  const value = row[column];
  return typeof value === 'string' ? value : String(value ?? '');
}

export function optionalRowText(
  row: Record<string, string | number | null>,
  column: string,
): string | null {
  const value = row[column];
  return value === null || value === undefined
    ? null
    : String(value);
}

export type FullBackupRow = FullBackupState['turns'][number];

export interface FullBackupLookup {
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

export function indexFullBackupRows(
  rows: FullBackupRow[],
): Map<string, FullBackupRow> {
  return new Map(
    rows.map((row) => [rowText(row, 'id'), row]),
  );
}

export function createFullBackupLookup(
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

export function parsedBackupJsonDeclaresProjectScope(
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

export function fullBackupJsonScopes(
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

export function backupRowDeclaresProjectScope(row: FullBackupRow): boolean {
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

export function legacyBackupContainsProjectScope(
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

export function fullBackupAggregateScope(
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

export function hydrateLegacyOutboxScope(
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

export function hydrateLegacySessionProjectBindings(
  state: FullBackupState,
): void {
  for (const row of state.sessions) {
    // schema < 26 never had an authoritative project column. Even if a
    // crafted legacy backup carries that key, it must not be promoted.
    row.project_id = null;
  }
}

export function hydrateLegacySessionIdentityBindings(
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

export function parseFullBackupJsonObject(
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

export function parseFullBackupOutboxPayload(
  row: FullBackupRow,
): Record<string, unknown> {
  return parseFullBackupJsonObject(
    rowText(row, 'payload_json'),
    '完整备份的 outbox payload',
  );
}

export function assertSubset(
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

export interface FullBackupAccessScope {
  scopeType: string;
  scopeKey: string;
}

export const FULL_BACKUP_ACCESS_SCOPE_TYPES = new Set([
  'personal',
  'project',
  'role',
  'session',
]);

export function fullBackupRowScope(
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

export function fullBackupMemoryScope(
  memory: MemoryBackup['memories'][number],
): FullBackupAccessScope {
  return {
    scopeType: memory.scopeType,
    scopeKey: memory.scopeKey,
  };
}

export function fullBackupScopesEqual(
  left: FullBackupAccessScope,
  right: FullBackupAccessScope,
): boolean {
  return left.scopeType === right.scopeType &&
    left.scopeKey === right.scopeKey;
}

export function fullBackupTurnSession(
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

export function assertFullBackupScopeAuthorizedBySession(
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

export function assertFullBackupScopeHasIdentitySession(
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

export function assertFullBackupJsonScopesAuthorized(
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

export function fullBackupConsolidationScopes(
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

export function validateReflectionBackupState(
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

export function validateFullBackupState(
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

