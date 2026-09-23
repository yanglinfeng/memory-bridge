import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DatabaseSync,
  type SQLInputValue,
} from 'node:sqlite';
import { config } from './config.js';
import {
  LifecycleStore,
  type MemoryJob,
} from './lifecycle-store.js';
import { MemoryStore } from './memory-store.js';
import {
  backfillTombstoneSemanticFingerprints,
} from './tombstone-policy.js';
import type { MemoryKind } from './types.js';

type DatabaseRow = Record<string, unknown>;

export interface MemoryGovernanceRecord {
  memoryId: string;
  userId: string;
  namespace: string;
  kind: MemoryKind;
  status: string;
  pinned: boolean;
  expiresAt: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  retrievedCount: number;
  usedCount: number;
  confirmedCount: number;
  rejectedCount: number;
}

export interface RetentionPolicy {
  id: string;
  userId: string;
  namespace: string;
  kind: MemoryKind | null;
  evidenceTtlDays: number | null;
  halfLifeDays: number | null;
  autoArchive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RetentionSweepResult {
  scanned: number;
  archived: number;
  protected: number;
  evidenceRedacted: number;
  episodesCompacted: number;
  episodesRehydrated: number;
  removedEmbeddingRows: number;
  removedDenseRows: number;
  removedAnnRows: number;
  removedTermRows: number;
}

export interface EpisodeRefinementResult {
  scanned: number;
  compacted: number;
  rehydrated: number;
  removedEmbeddingRows: number;
  removedDenseRows: number;
  removedAnnRows: number;
  removedTermRows: number;
  hotCutoff: string;
}

export interface PurgeJobRecord {
  id: string;
  memoryId: string;
  userId: string;
  namespace: string;
  contentHash: string;
  reason: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'dead';
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseUntil: string | null;
  leaseOwner: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  purgeBoundary: {
    managedMigrationBackups: true;
    externalExportCopies: false;
    notice: string;
  };
}

export interface RetrievalFeedbackExample {
  id: string;
  userId: string;
  namespace: string;
  traceId: string | null;
  memoryId: string | null;
  feedback: 'used' | 'confirmed' | 'rejected';
  queryHash: string;
  query: string | null;
  candidateRank: number | null;
  candidateScore: number | null;
  features: Record<string, unknown>;
  createdAt: string;
}

interface ManagedBackupPurgeResult {
  scanned: number;
  sanitized: number;
}

interface DerivedPurgeClosure {
  projectionRows: DatabaseRow[];
  projectionIds: string[];
  memoryIds: string[];
}

interface LayeredPurgeClosure extends DerivedPurgeClosure {
  turnIds: string[];
  episodeIds: string[];
  summaryIds: string[];
}

const PURGE_BOUNDARY: PurgeJobRecord['purgeBoundary'] = {
  managedMigrationBackups: true,
  externalExportCopies: false,
  notice:
    '物理清除覆盖本服务主数据库及同目录 migration-backups/；' +
    '用户自行下载、复制或移出系统管理范围的导出文件不受本服务控制。',
};

// 默认不衰减：系统不对用户数据做时间驱动的自动归档。
// 需要降噪的场景由调用方通过 retention policy 显式配置 halfLifeDays，
// 未配置即永久保留（数据安全优先于自动清理）。
const DEFAULT_HALF_LIFE_DAYS: Record<MemoryKind, number | null> = {
  profile: null,
  preference: null,
  project: null,
  event: null,
  knowledge: null,
  relationship: null,
  instruction: null,
  document_chunk: null,
};

// 默认不抹除证据原文：历史默认值（90 天）会把 conversation_turns.content
// 改写成 [retention-redacted] 并清空 memory_evidence.excerpt，属不可恢复的
// 内容销毁。现改为默认保留，需要抹除必须显式配置 evidenceTtlDays。
const DEFAULT_EVIDENCE_TTL_DAYS: number | null = null;

function cleanText(value: unknown, fallback = ''): string {
  return String(value ?? fallback).normalize('NFKC').trim();
}

function asNullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = cleanText(value);
  return text || null;
}

function asBoolean(value: unknown): boolean {
  return Number(value) === 1;
}

function parseRecord(value: unknown): Record<string, unknown> {
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizedPurgeReason(value: string): string {
  const reason = cleanText(value);
  return /^purged:[0-9a-f]{64}$/u.test(reason)
    ? reason
    : `purged:${sha256(reason)}`;
}

function isoTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !value.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error('TTL 必须是有效的 ISO 日期时间');
  }
  return new Date(timestamp).toISOString();
}

function clampInteger(
  value: number | null | undefined,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`数值必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function tableExists(
  database: DatabaseSync,
  table: string,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1
         FROM sqlite_master
         WHERE type IN ('table', 'view') AND name = ?
         LIMIT 1`,
      )
      .get(table),
  );
}

function tableColumns(
  database: DatabaseSync,
  table: string,
): Set<string> {
  if (!tableExists(database, table)) return new Set();
  return new Set(
    (
      database
        .prepare(`PRAGMA table_info("${table}")`)
        .all() as DatabaseRow[]
    ).map((row) => cleanText(row.name)),
  );
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function uniqueText(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => asNullableText(value))
        .filter((value): value is string => value !== null),
    ),
  ];
}

const CONSOLIDATION_STORED_SCOPE_PREFIX = 'access-v1:';
const CONSOLIDATION_SCOPE_TYPES = new Set([
  'session',
  'topic',
  'person',
  'project',
]);
const CONSOLIDATION_ACCESS_SCOPE_TYPES = new Set([
  'personal',
  'project',
  'role',
  'session',
]);

function projectionRebuildScope(
  row: DatabaseRow,
): Record<string, unknown> | null {
  const userId = cleanText(row.user_id);
  const namespace = cleanText(row.namespace);
  const scopeType = cleanText(row.scope_type);
  const storedScopeKey = cleanText(row.scope_key);
  if (
    !userId ||
    !namespace ||
    !CONSOLIDATION_SCOPE_TYPES.has(scopeType) ||
    !storedScopeKey
  ) {
    return null;
  }
  let scopeKey = storedScopeKey;
  let accessScopeType = 'personal';
  let accessScopeKey = 'self';
  if (
    storedScopeKey.startsWith(
      CONSOLIDATION_STORED_SCOPE_PREFIX,
    )
  ) {
    try {
      const decoded = JSON.parse(
        Buffer.from(
          storedScopeKey.slice(
            CONSOLIDATION_STORED_SCOPE_PREFIX.length,
          ),
          'base64url',
        ).toString('utf8'),
      ) as unknown;
      if (
        Array.isArray(decoded) &&
        decoded.length === 3 &&
        decoded.every((value) => typeof value === 'string') &&
        CONSOLIDATION_ACCESS_SCOPE_TYPES.has(decoded[0]) &&
        cleanText(decoded[1]) &&
        cleanText(decoded[2])
      ) {
        accessScopeType = cleanText(decoded[0]);
        accessScopeKey = cleanText(decoded[1]);
        scopeKey = cleanText(decoded[2]);
      }
    } catch {
      // Match the consolidator's legacy fallback for invalid stored keys.
    }
  }
  return {
    userId,
    namespace,
    scopeType,
    scopeKey,
    accessScopeType,
    accessScopeKey,
  };
}

function resolveDerivedPurgeClosure(
  database: DatabaseSync,
  rootMemoryId: string,
  userId: string,
  namespace: string,
): DerivedPurgeClosure {
  const rootId = cleanText(rootMemoryId);
  const ownerId = cleanText(userId);
  const scopedNamespace = cleanText(namespace);
  const projectionColumns = tableColumns(
    database,
    'derived_consolidations',
  );
  if (!projectionColumns.has('id')) {
    return {
      projectionRows: [],
      projectionIds: [],
      memoryIds: [rootId],
    };
  }
  if (
    !projectionColumns.has('user_id') ||
    !projectionColumns.has('namespace')
  ) {
    throw new Error(
      '物理清除已中止：derived_consolidations 缺少租户作用域',
    );
  }

  const sourceColumns = tableColumns(
    database,
    'derived_consolidation_sources',
  );
  const versionColumns = tableColumns(
    database,
    'memory_versions',
  );
  const canFollowSourceVersions =
    sourceColumns.has('consolidation_id') &&
    sourceColumns.has('memory_version_id') &&
    versionColumns.has('id') &&
    versionColumns.has('memory_item_id');
  const canFollowProjectionReferences =
    versionColumns.has('memory_item_id') &&
    versionColumns.has('source_ref');
  const itemColumns = tableColumns(database, 'memory_items');
  if (
    canFollowProjectionReferences &&
    (
      !itemColumns.has('id') ||
      !itemColumns.has('user_id') ||
      !itemColumns.has('namespace')
    )
  ) {
    throw new Error(
      '物理清除已中止：memory_items 缺少派生引用作用域',
    );
  }

  const memoryIds = new Set<string>([rootId]);
  const projections = new Map<string, DatabaseRow>();
  let changed = true;
  while (changed) {
    changed = false;
    const currentMemoryIds = [...memoryIds].sort();
    const memoryPlaceholders = placeholders(currentMemoryIds);
    const projectionConditions: string[] = [];
    const projectionValues: SQLInputValue[] = [];
    if (projectionColumns.has('memory_id')) {
      projectionConditions.push(
        `d.memory_id IN (${memoryPlaceholders})`,
      );
      projectionValues.push(...currentMemoryIds);
    }
    if (canFollowSourceVersions) {
      projectionConditions.push(
        `EXISTS (
           SELECT 1
           FROM derived_consolidation_sources source_link
           JOIN memory_versions source_version
             ON source_version.id = source_link.memory_version_id
           WHERE source_link.consolidation_id = d.id
             AND source_version.memory_item_id
               IN (${memoryPlaceholders})
         )`,
      );
      projectionValues.push(...currentMemoryIds);
    }
    if (canFollowProjectionReferences) {
      projectionConditions.push(
        `EXISTS (
           SELECT 1
           FROM memory_versions history
           WHERE history.memory_item_id
               IN (${memoryPlaceholders})
             ${
               versionColumns.has('source')
                 ? "AND history.source = 'consolidation'"
                 : ''
             }
             AND history.source_ref = 'consolidation:' || d.id
         )`,
      );
      projectionValues.push(...currentMemoryIds);
    }
    if (projectionConditions.length === 0) break;
    const rows = database
      .prepare(
        `SELECT d.*
         FROM derived_consolidations d
         WHERE d.user_id = ? AND d.namespace = ?
           AND (${projectionConditions.join(' OR ')})
         ORDER BY d.id`,
      )
      .all(
        ownerId,
        scopedNamespace,
        ...projectionValues,
      ) as DatabaseRow[];
    for (const row of rows) {
      const projectionId = cleanText(row.id);
      if (projectionId && !projections.has(projectionId)) {
        projections.set(projectionId, row);
        changed = true;
      }
      const attachedMemoryId = asNullableText(row.memory_id);
      if (attachedMemoryId && !memoryIds.has(attachedMemoryId)) {
        memoryIds.add(attachedMemoryId);
        changed = true;
      }
    }

    const projectionIds = [...projections.keys()].sort();
    if (
      !canFollowProjectionReferences ||
      projectionIds.length === 0
    ) {
      continue;
    }
    const sourceRefs = projectionIds.map(
      (id) => `consolidation:${id}`,
    );
    const referencedRows = database
      .prepare(
        `SELECT DISTINCT v.memory_item_id
         FROM memory_versions v
         JOIN memory_items i ON i.id = v.memory_item_id
         WHERE i.user_id = ? AND i.namespace = ?
           ${
             versionColumns.has('source')
               ? "AND v.source = 'consolidation'"
               : ''
           }
           AND v.source_ref IN (${placeholders(sourceRefs)})`,
      )
      .all(
        ownerId,
        scopedNamespace,
        ...sourceRefs,
      ) as DatabaseRow[];
    for (const row of referencedRows) {
      const referencedMemoryId = asNullableText(
        row.memory_item_id,
      );
      if (
        referencedMemoryId &&
        !memoryIds.has(referencedMemoryId)
      ) {
        memoryIds.add(referencedMemoryId);
        changed = true;
      }
    }
  }
  return {
    projectionRows: [...projections.values()],
    projectionIds: [...projections.keys()].sort(),
    memoryIds: [...memoryIds].sort(),
  };
}

function resolveLayeredPurgeClosure(
  database: DatabaseSync,
  rootMemoryId: string,
  userId: string,
  namespace: string,
): LayeredPurgeClosure {
  const rootId = cleanText(rootMemoryId);
  const ownerId = cleanText(userId);
  const scopedNamespace = cleanText(namespace);
  const memoryIds = new Set<string>([rootId]);
  const projections = new Map<string, DatabaseRow>();
  const turnIds = new Set<string>();
  const episodeIds = new Set<string>();
  const summaryIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const memoryId of [...memoryIds]) {
      const derived = resolveDerivedPurgeClosure(
        database,
        memoryId,
        ownerId,
        scopedNamespace,
      );
      for (const row of derived.projectionRows) {
        const id = cleanText(row.id);
        if (id && !projections.has(id)) {
          projections.set(id, row);
          changed = true;
        }
      }
      for (const id of derived.memoryIds) {
        if (id && !memoryIds.has(id)) {
          memoryIds.add(id);
          changed = true;
        }
      }
    }

    const targets = [...memoryIds].sort();
    const versionColumns = tableColumns(database, 'memory_versions');
    const evidenceColumns = tableColumns(database, 'memory_evidence');
    if (
      versionColumns.has('id') &&
      versionColumns.has('memory_item_id') &&
      evidenceColumns.has('memory_version_id') &&
      evidenceColumns.has('turn_id')
    ) {
      const evidenceRows = database.prepare(
        `SELECT DISTINCT evidence.turn_id
         FROM memory_evidence evidence
         JOIN memory_versions version
           ON version.id = evidence.memory_version_id
         WHERE version.memory_item_id IN (${placeholders(targets)})
           AND evidence.turn_id IS NOT NULL`,
      ).all(...targets) as DatabaseRow[];
      for (const id of completedExchangeTurnIds(
        database,
        uniqueText(evidenceRows.map((row) => row.turn_id)),
      )) {
        if (!turnIds.has(id)) {
          turnIds.add(id);
          changed = true;
        }
      }
    }

    const observationColumns = tableColumns(
      database,
      'memory_pattern_observations',
    );
    const currentTurnIds = [...turnIds].sort();
    if (observationColumns.size > 0 && currentTurnIds.length > 0) {
      for (const column of [
        'user_id', 'namespace', 'scope_type', 'scope_key',
        'claim_fingerprint', 'turn_id',
      ]) {
        if (!observationColumns.has(column)) {
          throw new Error(
            '物理清除已中止：memory_pattern_observations 缺少累计证据边界',
          );
        }
      }
      const seedRows = database.prepare(
        `SELECT user_id, namespace, scope_type, scope_key,
                claim_fingerprint, turn_id
         FROM memory_pattern_observations
         WHERE turn_id IN (${placeholders(currentTurnIds)})`,
      ).all(...currentTurnIds) as DatabaseRow[];
      if (seedRows.some((row) =>
        cleanText(row.user_id) !== ownerId ||
        cleanText(row.namespace) !== scopedNamespace
      )) {
        throw new Error(
          '物理清除已中止：pattern observation 跨租户引用受影响 turn',
        );
      }
      const clusterKeys = new Map<string, DatabaseRow>();
      for (const row of seedRows) {
        const key = [
          row.scope_type,
          row.scope_key,
          row.claim_fingerprint,
        ].map((value) => cleanText(value)).join('\0');
        clusterKeys.set(key, row);
      }
      for (const row of clusterKeys.values()) {
        const clusterRows = database.prepare(
          `SELECT turn_id
           FROM memory_pattern_observations
           WHERE user_id = ? AND namespace = ?
             AND scope_type = ? AND scope_key = ?
             AND claim_fingerprint = ?`,
        ).all(
          ownerId,
          scopedNamespace,
          cleanText(row.scope_type),
          cleanText(row.scope_key),
          cleanText(row.claim_fingerprint),
        ) as DatabaseRow[];
        for (const clusterRow of clusterRows) {
          const turnId = cleanText(clusterRow.turn_id);
          if (turnId && !turnIds.has(turnId)) {
            turnIds.add(turnId);
            changed = true;
          }
        }
      }
    }

    const episodeColumns = tableColumns(database, 'conversation_episodes');
    if (episodeColumns.size > 0) {
      for (const column of [
        'id', 'memory_id', 'user_id', 'namespace',
        'user_turn_id', 'assistant_turn_id',
      ]) {
        if (!episodeColumns.has(column)) {
          throw new Error(
            '物理清除已中止：conversation_episodes 缺少租户引用边界',
          );
        }
      }
      const episodeConditions = [
        `memory_id IN (${placeholders(targets)})`,
      ];
      const episodeValues: SQLInputValue[] = [...targets];
      const currentTurnIds = [...turnIds].sort();
      if (currentTurnIds.length > 0) {
        episodeConditions.push(
          `user_turn_id IN (${placeholders(currentTurnIds)})`,
          `assistant_turn_id IN (${placeholders(currentTurnIds)})`,
        );
        episodeValues.push(...currentTurnIds, ...currentTurnIds);
      }
      const rows = database.prepare(
        `SELECT * FROM conversation_episodes
         WHERE ${episodeConditions.join(' OR ')}`,
      ).all(...episodeValues) as DatabaseRow[];
      if (rows.some(
        (row) => cleanText(row.user_id) !== ownerId ||
          cleanText(row.namespace) !== scopedNamespace,
      )) {
        throw new Error(
          '物理清除已中止：conversation_episodes 租户作用域错配',
        );
      }
      for (const row of rows) {
        const episodeId = cleanText(row.id);
        const memoryId = cleanText(row.memory_id);
        if (episodeId && !episodeIds.has(episodeId)) {
          episodeIds.add(episodeId);
          changed = true;
        }
        if (memoryId && !memoryIds.has(memoryId)) {
          memoryIds.add(memoryId);
          changed = true;
        }
        for (const id of [row.user_turn_id, row.assistant_turn_id]) {
          const turnId = cleanText(id);
          if (turnId && !turnIds.has(turnId)) {
            turnIds.add(turnId);
            changed = true;
          }
        }
      }
    }

    const summaryColumns = tableColumns(
      database,
      'conversation_memory_summaries',
    );
    if (summaryColumns.size > 0) {
      for (const column of ['id', 'memory_id', 'user_id', 'namespace']) {
        if (!summaryColumns.has(column)) {
          throw new Error(
            '物理清除已中止：conversation_memory_summaries 缺少租户引用边界',
          );
        }
      }
      const summaryConditions = [
        `summary.memory_id IN (${placeholders(targets)})`,
      ];
      const summaryValues: SQLInputValue[] = [...targets];
      const currentEpisodeIds = [...episodeIds].sort();
      const sourceColumns = tableColumns(
        database,
        'conversation_memory_summary_sources',
      );
      if (currentEpisodeIds.length > 0 && sourceColumns.size > 0) {
        if (
          !sourceColumns.has('summary_id') ||
          !sourceColumns.has('episode_id')
        ) {
          throw new Error(
            '物理清除已中止：层级摘要来源缺少引用边界',
          );
        }
        summaryConditions.push(
          `EXISTS (
             SELECT 1
             FROM conversation_memory_summary_sources source
             WHERE source.summary_id = summary.id
               AND source.episode_id IN (
                 ${placeholders(currentEpisodeIds)}
               )
           )`,
        );
        summaryValues.push(...currentEpisodeIds);
      }
      const rows = database.prepare(
        `SELECT summary.*
         FROM conversation_memory_summaries summary
         WHERE ${summaryConditions.join(' OR ')}`,
      ).all(...summaryValues) as DatabaseRow[];
      if (rows.some(
        (row) => cleanText(row.user_id) !== ownerId ||
          cleanText(row.namespace) !== scopedNamespace,
      )) {
        throw new Error(
          '物理清除已中止：层级摘要租户作用域错配',
        );
      }
      for (const row of rows) {
        const summaryId = cleanText(row.id);
        const memoryId = cleanText(row.memory_id);
        if (summaryId && !summaryIds.has(summaryId)) {
          summaryIds.add(summaryId);
          changed = true;
        }
        if (memoryId && !memoryIds.has(memoryId)) {
          memoryIds.add(memoryId);
          changed = true;
        }
      }
    }
  }
  return {
    projectionRows: [...projections.values()],
    projectionIds: [...projections.keys()].sort(),
    memoryIds: [...memoryIds].sort(),
    turnIds: [...turnIds].sort(),
    episodeIds: [...episodeIds].sort(),
    summaryIds: [...summaryIds].sort(),
  };
}

function deleteLayeredPurgeRows(
  database: DatabaseSync,
  closure: LayeredPurgeClosure,
  userId: string,
  namespace: string,
): void {
  if (
    closure.turnIds.length > 0 &&
    tableExists(database, 'memory_pattern_observations')
  ) {
    const observationColumns = tableColumns(
      database,
      'memory_pattern_observations',
    );
    if (
      !observationColumns.has('user_id') ||
      !observationColumns.has('namespace') ||
      !observationColumns.has('turn_id')
    ) {
      throw new Error(
        '物理清除已中止：memory_pattern_observations 缺少租户证据边界',
      );
    }
    database.prepare(
      `DELETE FROM memory_pattern_observations
       WHERE user_id = ? AND namespace = ?
         AND turn_id IN (${placeholders(closure.turnIds)})`,
    ).run(userId, namespace, ...closure.turnIds);
  }
  if (
    closure.summaryIds.length > 0 &&
    tableExists(database, 'conversation_memory_summaries')
  ) {
    database.prepare(
      `DELETE FROM conversation_memory_summaries
       WHERE id IN (${placeholders(closure.summaryIds)})
         AND user_id = ? AND namespace = ?`,
    ).run(...closure.summaryIds, userId, namespace);
  }
  if (
    closure.episodeIds.length > 0 &&
    tableExists(database, 'conversation_episodes')
  ) {
    database.prepare(
      `DELETE FROM conversation_episodes
       WHERE id IN (${placeholders(closure.episodeIds)})
         AND user_id = ? AND namespace = ?`,
    ).run(...closure.episodeIds, userId, namespace);
  }
}

function assertProjectionReferencesCleared(
  database: DatabaseSync,
  projectionIds: string[],
  label: string,
): void {
  if (projectionIds.length === 0) return;
  const versionColumns = tableColumns(
    database,
    'memory_versions',
  );
  if (!versionColumns.has('source_ref')) return;
  const sourceRefs = projectionIds.map(
    (id) => `consolidation:${id}`,
  );
  const remaining = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM memory_versions
         WHERE source_ref IN (${placeholders(sourceRefs)})`,
      )
      .get(...sourceRefs)?.count || 0,
  );
  if (remaining > 0) {
    throw new Error(
      `${label}仍有 ${remaining} 条版本引用待删除 projection`,
    );
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(cleanText(value, '{}')) as unknown;
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function completedExchangeTurnIds(
  database: DatabaseSync,
  directTurnIds: string[],
): string[] {
  const direct = uniqueText(directTurnIds);
  if (direct.length === 0) return [];
  const columns = tableColumns(database, 'conversation_turns');
  if (
    ![
      'id',
      'session_id',
      'user_id',
      'namespace',
      'external_id',
      'role',
      'metadata_json',
    ].every((column) => columns.has(column))
  ) {
    return direct;
  }
  const directRows = database
    .prepare(
      `SELECT id, session_id, user_id, namespace, external_id,
              role, metadata_json
       FROM conversation_turns
       WHERE id IN (${placeholders(direct)})`,
    )
    .all(...direct) as DatabaseRow[];
  const sessionIds = uniqueText(
    directRows.map((row) => row.session_id),
  );
  if (sessionIds.length === 0) return direct;
  const sessionRows = database
    .prepare(
      `SELECT id, session_id, user_id, namespace, external_id,
              role, metadata_json
       FROM conversation_turns
       WHERE session_id IN (${placeholders(sessionIds)})`,
    )
    .all(...sessionIds) as DatabaseRow[];
  const directSet = new Set(direct);
  const userByIdentity = new Map<string, DatabaseRow>();
  for (const row of sessionRows) {
    if (cleanText(row.role) !== 'user') continue;
    userByIdentity.set(
      [
        cleanText(row.session_id),
        cleanText(row.user_id),
        cleanText(row.namespace),
        cleanText(row.external_id),
      ].join('\0'),
      row,
    );
  }
  const expanded = new Set(direct);
  for (const assistant of sessionRows) {
    if (cleanText(assistant.role) !== 'assistant') continue;
    const respondsTo = asNullableText(
      parseObject(assistant.metadata_json).respondsTo,
    );
    if (!respondsTo) continue;
    const user = userByIdentity.get(
      [
        cleanText(assistant.session_id),
        cleanText(assistant.user_id),
        cleanText(assistant.namespace),
        respondsTo,
      ].join('\0'),
    );
    if (
      !user ||
      (
        !directSet.has(cleanText(user.id)) &&
        !directSet.has(cleanText(assistant.id))
      )
    ) {
      continue;
    }
    expanded.add(cleanText(user.id));
    expanded.add(cleanText(assistant.id));
  }
  return [...expanded];
}

function sanitizeConversationTurnArtifacts(
  database: DatabaseSync,
  turnIdsInput: string[],
  userId: string,
  namespace: string,
  timestamp: string,
  auditHash: string,
): void {
  const turnIds = uniqueText(turnIdsInput);
  if (turnIds.length === 0) return;
  const turnColumns = tableColumns(database, 'conversation_turns');
  if (
    !turnColumns.has('id') ||
    !turnColumns.has('user_id') ||
    !turnColumns.has('namespace') ||
    !turnColumns.has('content')
  ) {
    throw new Error('物理清除已中止：conversation_turns 缺少租户正文边界');
  }
  const rows = database
    .prepare(
      `SELECT id, session_id,
              ${turnColumns.has('round_id') ? 'round_id' : 'NULL AS round_id'}
       FROM conversation_turns
       WHERE id IN (${placeholders(turnIds)})
         AND user_id = ? AND namespace = ?`,
    )
    .all(...turnIds, userId, namespace) as DatabaseRow[];
  if (rows.length !== turnIds.length) {
    throw new Error('物理清除已中止：conversation_turns 租户作用域错配');
  }
  const sessionIds = uniqueText(rows.map((row) => row.session_id));
  const roundIds = uniqueText(rows.map((row) => row.round_id));
  const assignments = ["content = '[purged]'"];
  const assignmentValues: SQLInputValue[] = [];
  if (turnColumns.has('display_content')) {
    assignments.push("display_content = '[purged]'");
  }
  if (turnColumns.has('normalized_content')) {
    assignments.push('normalized_content = NULL');
  }
  if (turnColumns.has('content_hash')) {
    assignments.push('content_hash = ?');
    assignmentValues.push(sha256(`purged:${auditHash}`));
  }
  if (turnColumns.has('metadata_json')) {
    assignments.push('metadata_json = ?');
    assignmentValues.push(JSON.stringify({
      purgedAt: timestamp,
      purgedHash: auditHash,
    }));
  }
  database
    .prepare(
      `UPDATE conversation_turns
       SET ${assignments.join(', ')}
       WHERE id IN (${placeholders(turnIds)})
         AND user_id = ? AND namespace = ?`,
    )
    .run(...assignmentValues, ...turnIds, userId, namespace);

  const actionColumns = tableColumns(
    database,
    'conversation_message_actions',
  );
  if (actionColumns.has('message_id')) {
    database
      .prepare(
        `DELETE FROM conversation_message_actions
         WHERE message_id IN (${placeholders(turnIds)})`,
      )
      .run(...turnIds);
  }

  const roundEventColumns = tableColumns(
    database,
    'conversation_round_events',
  );
  if (
    roundIds.length > 0 &&
    roundEventColumns.has('round_id') &&
    roundEventColumns.has('data_json')
  ) {
    const roundAssignments = [
      `data_json = json_object(
         'roundId', round_id, 'purged', json('true')
       )`,
    ];
    if (roundEventColumns.has('contains_body')) {
      roundAssignments.push('contains_body = 0');
    }
    database
      .prepare(
        `UPDATE conversation_round_events
         SET ${roundAssignments.join(', ')}
         WHERE round_id IN (${placeholders(roundIds)})`,
      )
      .run(...roundIds);
  }

  const sessionColumns = tableColumns(database, 'conversation_sessions');
  if (
    sessionIds.length > 0 &&
    sessionColumns.has('id') &&
    sessionColumns.has('last_message_preview') &&
    turnColumns.has('session_id')
  ) {
    const displayExpression = turnColumns.has('display_content')
      ? 'COALESCE(t.display_content, t.content)'
      : 't.content';
    const orderExpression = turnColumns.has('message_sequence')
      ? 't.message_sequence DESC, t.occurred_at DESC, t.id DESC'
      : 't.occurred_at DESC, t.id DESC';
    database
      .prepare(
        `UPDATE conversation_sessions
         SET last_message_preview = (
           SELECT SUBSTR(${displayExpression}, 1, 160)
           FROM conversation_turns t
           WHERE t.session_id = conversation_sessions.id
           ORDER BY ${orderExpression}
           LIMIT 1
         )
         WHERE id IN (${placeholders(sessionIds)})
           AND user_id = ? AND namespace = ?`,
      )
      .run(...sessionIds, userId, namespace);
  }

  const changeColumns = tableColumns(database, 'conversation_changes');
  if (
    changeColumns.has('resource_id') &&
    changeColumns.has('resource_json') &&
    changeColumns.has('tombstone') &&
    changeColumns.has('user_id') &&
    changeColumns.has('namespace')
  ) {
    database
      .prepare(
        `UPDATE conversation_changes
         SET tombstone = 1, resource_json = NULL
         WHERE user_id = ? AND namespace = ?
           AND resource_id IN (${placeholders(turnIds)})`,
      )
      .run(userId, namespace, ...turnIds);
    if (
      sessionIds.length > 0 &&
      changeColumns.has('conversation_id') &&
      sessionColumns.has('last_message_preview')
    ) {
      database
        .prepare(
          `UPDATE conversation_changes
           SET resource_json = json_set(
             resource_json,
             '$.lastMessagePreview',
             (
               SELECT s.last_message_preview
               FROM conversation_sessions s
               WHERE s.id = conversation_changes.conversation_id
             )
           )
           WHERE user_id = ? AND namespace = ?
             AND conversation_id IN (${placeholders(sessionIds)})
             AND resource_json IS NOT NULL
             AND event_type = 'conversation.upsert'`,
        )
        .run(userId, namespace, ...sessionIds);
    }
  }
}

function prepareSecureFtsDeletion(database: DatabaseSync): void {
  database.exec('PRAGMA secure_delete = ON;');
  const secureDelete = database
    .prepare('PRAGMA secure_delete')
    .get() as DatabaseRow | undefined;
  if (Number(secureDelete?.secure_delete) !== 1) {
    throw new Error('物理清除已中止：SQLite secure_delete 未启用');
  }
  if (!tableExists(database, 'memories_fts')) return;
  database.exec(
    `INSERT INTO memories_fts(memories_fts, rank)
     VALUES('secure-delete', 1);`,
  );
}

function rebuildSecureFts(database: DatabaseSync): void {
  if (!tableExists(database, 'memories_fts')) return;
  database.exec(`
    INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    INSERT INTO memories_fts(memories_fts) VALUES('optimize');
  `);
}

function checkpointTruncate(
  database: DatabaseSync,
  label: string,
): void {
  const checkpoint = database
    .prepare('PRAGMA wal_checkpoint(TRUNCATE)')
    .get() as DatabaseRow | undefined;
  if (!checkpoint || Number(checkpoint.busy) !== 0) {
    throw new Error(`${label} WAL 截断未完成，将由 Worker 重试`);
  }
}

function rowToGovernance(row: DatabaseRow): MemoryGovernanceRecord {
  return {
    memoryId: cleanText(row.id),
    userId: cleanText(row.user_id),
    namespace: cleanText(row.namespace),
    kind: cleanText(row.kind) as MemoryKind,
    status: cleanText(row.status),
    pinned: asBoolean(row.pinned),
    expiresAt: asNullableText(row.expires_at),
    archivedAt: asNullableText(row.archived_at),
    archiveReason: asNullableText(row.archive_reason),
    retrievedCount: Number(row.retrieved_count),
    usedCount: Number(row.used_count),
    confirmedCount: Number(row.confirmed_count),
    rejectedCount: Number(row.rejected_count),
  };
}

function rowToPolicy(row: DatabaseRow): RetentionPolicy {
  return {
    id: cleanText(row.id),
    userId: cleanText(row.user_id),
    namespace: cleanText(row.namespace),
    kind: asNullableText(row.kind) as MemoryKind | null,
    evidenceTtlDays:
      row.evidence_ttl_days === null
        ? null
        : Number(row.evidence_ttl_days),
    halfLifeDays:
      row.half_life_days === null
        ? null
        : Number(row.half_life_days),
    autoArchive: asBoolean(row.auto_archive),
    createdAt: cleanText(row.created_at),
    updatedAt: cleanText(row.updated_at),
  };
}

function rowToPurgeJob(row: DatabaseRow): PurgeJobRecord {
  return {
    id: cleanText(row.id),
    memoryId: cleanText(row.memory_id),
    userId: cleanText(row.user_id),
    namespace: cleanText(row.namespace),
    contentHash: cleanText(row.content_hash),
    reason: cleanText(row.reason),
    status: cleanText(row.status) as PurgeJobRecord['status'],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: cleanText(row.available_at),
    leaseUntil: asNullableText(row.lease_until),
    leaseOwner: asNullableText(row.lease_owner),
    lastError: asNullableText(row.last_error),
    createdAt: cleanText(row.created_at),
    updatedAt: cleanText(row.updated_at),
    completedAt: asNullableText(row.completed_at),
    purgeBoundary: PURGE_BOUNDARY,
  };
}

export class MemoryGovernance {
  constructor(
    private readonly database: DatabaseSync,
    private readonly lifecycleStore: LifecycleStore,
    private readonly memoryStore: MemoryStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get(memoryId: string, userId = config.defaultUserId):
  MemoryGovernanceRecord | null {
    const row = this.database
      .prepare(
        `SELECT i.*
         FROM memory_items i
         WHERE i.id = ? AND i.user_id = ?`,
      )
      .get(cleanText(memoryId), cleanText(userId)) as
      DatabaseRow | undefined;
    return row ? rowToGovernance(row) : null;
  }

  archiveMemory(
    memoryId: string,
    reason = 'manual_archive',
    userId = config.defaultUserId,
  ): MemoryGovernanceRecord {
    const normalizedReason = cleanText(reason, 'manual_archive');
    return this.transitionArchiveState(
      memoryId,
      userId,
      'active',
      'archived',
      normalizedReason,
      this.now(),
      'archived',
      { reason: normalizedReason, actor: 'user' },
    );
  }

  unarchiveMemory(
    memoryId: string,
    userId = config.defaultUserId,
  ): MemoryGovernanceRecord {
    return this.transitionArchiveState(
      memoryId,
      userId,
      'archived',
      'active',
      null,
      this.now(),
      'unarchived',
      { actor: 'user' },
    );
  }

  setPinned(
    memoryId: string,
    pinned: boolean,
    userId = config.defaultUserId,
  ): MemoryGovernanceRecord {
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE memory_items
         SET pinned = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        pinned ? 1 : 0,
        timestamp,
        cleanText(memoryId),
        cleanText(userId),
      );
    if (Number(result.changes) !== 1) {
      throw new Error('记忆不存在或不属于当前用户');
    }
    this.recordEvent(
      memoryId,
      userId,
      pinned ? 'pinned' : 'unpinned',
      { pinned },
      timestamp,
    );
    return this.get(memoryId, userId)!;
  }

  setTtl(
    memoryId: string,
    expiresAt: string | null,
    userId = config.defaultUserId,
  ): MemoryGovernanceRecord {
    const normalizedExpiry = isoTimestamp(expiresAt);
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE memory_items
         SET expires_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        normalizedExpiry,
        timestamp,
        cleanText(memoryId),
        cleanText(userId),
      );
    if (Number(result.changes) !== 1) {
      throw new Error('记忆不存在或不属于当前用户');
    }
    this.recordEvent(
      memoryId,
      userId,
      'ttl_changed',
      { expiresAt: normalizedExpiry },
      timestamp,
    );
    return this.get(memoryId, userId)!;
  }

  recordFeedback(
    memoryId: string,
    feedback: 'retrieved' | 'used' | 'confirmed' | 'rejected',
    userId = config.defaultUserId,
    traceId?: string,
  ): MemoryGovernanceRecord {
    const columns = {
      retrieved: 'retrieved_count',
      used: 'used_count',
      confirmed: 'confirmed_count',
      rejected: 'rejected_count',
    } as const;
    const column = columns[feedback];
    const timestamp = this.now();
    const ownerId = cleanText(userId);
    const targetMemoryId = cleanText(memoryId);
    let linkedTrace: DatabaseRow | undefined;
    const requestedTraceId = cleanText(traceId);
    if (feedback !== 'retrieved') {
      const traceSql = requestedTraceId
        ? `SELECT t.*
           FROM retrieval_traces t
           WHERE t.trace_id = ? AND t.user_id = ?
             AND EXISTS (
               SELECT 1
               FROM retrieval_trace_events e
               WHERE e.trace_id = t.trace_id
                 AND e.stage = 'selection'
                 AND e.event_json LIKE ?
             )`
        : `SELECT t.*
           FROM retrieval_traces t
           WHERE t.user_id = ?
             AND EXISTS (
               SELECT 1
               FROM retrieval_trace_events e
               WHERE e.trace_id = t.trace_id
                 AND e.stage = 'selection'
                 AND e.event_json LIKE ?
             )
           ORDER BY t.started_at DESC
           LIMIT 1`;
      linkedTrace = requestedTraceId
        ? this.database.prepare(traceSql).get(
            requestedTraceId,
            ownerId,
            `%${targetMemoryId}%`,
          ) as DatabaseRow | undefined
        : this.database.prepare(traceSql).get(
            ownerId,
            `%${targetMemoryId}%`,
          ) as DatabaseRow | undefined;
      if (requestedTraceId && !linkedTrace) {
        throw new Error('反馈 trace 不存在、跨账户或未包含该记忆');
      }
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(
          `UPDATE memory_items
           SET ${column} = ${column} + 1, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .run(timestamp, targetMemoryId, ownerId);
      if (Number(result.changes) !== 1) {
        throw new Error('记忆不存在或不属于当前用户');
      }
      if (feedback !== 'retrieved') {
        const traceIdentifier = linkedTrace
          ? cleanText(linkedTrace.trace_id)
          : null;
        const selection = traceIdentifier
          ? this.database
              .prepare(
                `SELECT event_json
                 FROM retrieval_trace_events
                 WHERE trace_id = ? AND stage = 'selection'
                 ORDER BY sequence DESC
                 LIMIT 1`,
              )
              .get(traceIdentifier) as DatabaseRow | undefined
          : undefined;
        const selectionDetail = parseRecord(selection?.event_json);
        const results = Array.isArray(selectionDetail.results)
          ? selectionDetail.results
          : [];
        const matchedIndex = results.findIndex((entry) =>
          entry && typeof entry === 'object' &&
          cleanText((entry as Record<string, unknown>).memoryId) ===
            targetMemoryId,
        );
        const matched = matchedIndex >= 0
          ? results[matchedIndex] as Record<string, unknown>
          : {};
        this.database
          .prepare(
            `INSERT INTO retrieval_feedback_examples (
               id, user_id, namespace, trace_id, memory_id, feedback,
               query_hash, query_text, candidate_rank, candidate_score,
               features_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            ownerId,
            linkedTrace
              ? cleanText(linkedTrace.namespace)
              : config.defaultNamespace,
            traceIdentifier,
            targetMemoryId,
            feedback,
            linkedTrace
              ? cleanText(linkedTrace.query_hash)
              : sha256(`unlinked:${targetMemoryId}`),
            linkedTrace
              ? asNullableText(linkedTrace.query_text)
              : null,
            matchedIndex >= 0 ? matchedIndex + 1 : null,
            Number.isFinite(Number(matched.score))
              ? Number(matched.score)
              : null,
            JSON.stringify({
              traceLinked: Boolean(traceIdentifier),
              explanation:
                matched.explanation &&
                typeof matched.explanation === 'object'
                  ? matched.explanation
                  : null,
            }),
            timestamp,
          );
      }
      this.recordEvent(
        targetMemoryId,
        ownerId,
        `feedback_${feedback}`,
        {
          feedback,
          traceId: linkedTrace
            ? cleanText(linkedTrace.trace_id)
            : null,
        },
        timestamp,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(memoryId, userId)!;
  }

  listFeedbackExamples(
    userId = config.defaultUserId,
    input: {
      feedback?: 'used' | 'confirmed' | 'rejected';
      limit?: number;
      offset?: number;
    } = {},
  ): RetrievalFeedbackExample[] {
    const clauses = ['user_id = ?'];
    const values: Array<string | number> = [cleanText(userId)];
    if (input.feedback) {
      clauses.push('feedback = ?');
      values.push(input.feedback);
    }
    values.push(
      Math.max(1, Math.min(input.limit || 200, 1_000)),
      Math.max(0, Math.trunc(input.offset || 0)),
    );
    return (
      this.database
        .prepare(
          `SELECT *
           FROM retrieval_feedback_examples
           WHERE ${clauses.join(' AND ')}
           ORDER BY created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...values) as DatabaseRow[]
    ).map((row) => ({
      id: cleanText(row.id),
      userId: cleanText(row.user_id),
      namespace: cleanText(row.namespace),
      traceId: asNullableText(row.trace_id),
      memoryId: asNullableText(row.memory_id),
      feedback: cleanText(row.feedback) as
        RetrievalFeedbackExample['feedback'],
      queryHash: cleanText(row.query_hash),
      query: asNullableText(row.query_text),
      candidateRank: row.candidate_rank === null
        ? null
        : Number(row.candidate_rank),
      candidateScore: row.candidate_score === null
        ? null
        : Number(row.candidate_score),
      features: parseRecord(row.features_json),
      createdAt: cleanText(row.created_at),
    }));
  }

  upsertPolicy(input: {
    userId?: string;
    namespace?: string;
    kind?: MemoryKind | null;
    evidenceTtlDays?: number | null;
    halfLifeDays?: number | null;
    autoArchive?: boolean;
  }): RetentionPolicy {
    const userId = cleanText(input.userId, config.defaultUserId);
    const namespace = cleanText(
      input.namespace,
      config.defaultNamespace,
    );
    const kind = input.kind || null;
    const evidenceTtlDays = clampInteger(
      input.evidenceTtlDays,
      1,
      3650,
    );
    const halfLifeDays = clampInteger(
      input.halfLifeDays,
      1,
      3650,
    );
    const timestamp = this.now();
    const id = `retention:${sha256([
      userId,
      namespace,
      kind || '*',
    ].join('\u0000'))}`;
    this.database
      .prepare(
        `INSERT INTO retention_policies (
           id, user_id, namespace, kind, evidence_ttl_days,
           half_life_days, auto_archive, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           evidence_ttl_days = excluded.evidence_ttl_days,
           half_life_days = excluded.half_life_days,
           auto_archive = excluded.auto_archive,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        userId,
        namespace,
        kind,
        evidenceTtlDays,
        halfLifeDays,
        input.autoArchive === false ? 0 : 1,
        timestamp,
        timestamp,
      );
    return rowToPolicy(
      this.database
        .prepare('SELECT * FROM retention_policies WHERE id = ?')
        .get(id) as DatabaseRow,
    );
  }

  listPolicies(
    userId = config.defaultUserId,
  ): RetentionPolicy[] {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM retention_policies
           WHERE user_id = ?
           ORDER BY namespace ASC, kind ASC`,
        )
        .all(cleanText(userId)) as DatabaseRow[]
    ).map(rowToPolicy);
  }

  refineEpisodeIndexes(input: {
    userId?: string;
    namespace?: string;
    at?: string;
    hotDays?: number;
    batchSize?: number;
  } = {}): EpisodeRefinementResult {
    const userId = cleanText(input.userId, config.defaultUserId);
    const namespace = input.namespace
      ? cleanText(input.namespace)
      : null;
    const timestamp = input.at
      ? isoTimestamp(input.at)!
      : this.now();
    const hotDays = Math.max(
      7,
      Math.min(365, Math.trunc(
        input.hotDays ?? config.episodeHotDays,
      )),
    );
    const batchSize = Math.max(
      50,
      Math.min(5_000, Math.trunc(
        input.batchSize ?? config.episodeCompactionBatchSize,
      )),
    );
    const hotCutoff = new Date(
      Date.parse(timestamp) - hotDays * 86_400_000,
    ).toISOString();
    const namespaceSql = namespace ? 'AND c.namespace = ?' : '';
    const staleValues: SQLInputValue[] = [userId];
    if (namespace) staleValues.push(namespace);
    staleValues.push(batchSize);
    const staleRows = this.database.prepare(
      `SELECT c.episode_id, c.memory_id, c.summary_id, c.namespace,
              e.status AS episode_status,
              m.status AS memory_status
       FROM conversation_episode_compactions c
       JOIN conversation_episodes e ON e.id = c.episode_id
       JOIN memories m ON m.id = c.memory_id
       LEFT JOIN conversation_memory_summaries summary
         ON summary.id = c.summary_id
       LEFT JOIN memories summary_memory
         ON summary_memory.id = summary.memory_id
       WHERE c.user_id = ?
         ${namespaceSql}
         AND e.status = 'active'
         AND m.status = 'active'
         AND (
           summary.id IS NULL
           OR summary.status != 'active'
           OR summary_memory.status != 'active'
         )
       ORDER BY c.compacted_at ASC, c.episode_id ASC
       LIMIT ?`,
    ).all(...staleValues) as DatabaseRow[];

    let rehydrated = 0;
    if (staleRows.length > 0) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        for (const row of staleRows) {
          const memoryId = cleanText(row.memory_id);
          const removed = this.database.prepare(
            `DELETE FROM conversation_episode_compactions
             WHERE episode_id = ? AND memory_id = ?`,
          ).run(cleanText(row.episode_id), memoryId);
          if (Number(removed.changes) !== 1) continue;
          this.memoryStore.refreshLocalRetrievalIndex(
            memoryId,
            userId,
            cleanText(row.namespace),
          );
          this.recordEvent(
            memoryId,
            userId,
            'episode_rehydrated',
            {
              episodeId: cleanText(row.episode_id),
              previousSummaryId: asNullableText(row.summary_id),
            },
            timestamp,
          );
          rehydrated += 1;
        }
        if (rehydrated > 0) {
          this.insertAudit(
            'episode_indexes_rehydrated',
            null,
            userId,
            { namespace, rehydrated },
            timestamp,
          );
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }

    const candidateNamespaceSql = namespace
      ? 'AND candidate.namespace = ?'
      : '';
    const candidateValues: SQLInputValue[] = [userId, hotCutoff];
    if (namespace) candidateValues.push(namespace);
    candidateValues.push(batchSize);
    const candidates = this.database.prepare(
      `SELECT *
       FROM (
         SELECT e.id AS episode_id, e.memory_id, e.user_id,
                e.namespace, e.occurred_at,
                (
                  SELECT summary.id
                  FROM conversation_memory_summary_sources source_link
                  JOIN conversation_memory_summaries summary
                    ON summary.id = source_link.summary_id
                  JOIN memories summary_memory
                    ON summary_memory.id = summary.memory_id
                  WHERE source_link.episode_id = e.id
                    AND summary.summary_type = 'week'
                    AND summary.status = 'active'
                    AND summary_memory.status = 'active'
                  ORDER BY summary.updated_at DESC, summary.id DESC
                  LIMIT 1
                ) AS summary_id
         FROM conversation_episodes e
         JOIN memories m ON m.id = e.memory_id
         JOIN memory_items i ON i.id = e.memory_id
         WHERE e.user_id = ?
           AND e.occurred_at < ?
           AND e.status = 'active'
           AND m.status = 'active'
           AND m.source = 'conversation_episode'
           AND i.status = 'active'
           AND i.pinned = 0
           AND EXISTS (
             SELECT 1 FROM memories_fts f
             WHERE f.memory_id = e.memory_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM conversation_episode_compactions compacted
             WHERE compacted.episode_id = e.id
           )
       ) candidate
       WHERE candidate.summary_id IS NOT NULL
         ${candidateNamespaceSql}
       ORDER BY candidate.occurred_at ASC, candidate.episode_id ASC
       LIMIT ?`,
    ).all(...candidateValues) as DatabaseRow[];

    let compacted = 0;
    let removedEmbeddingRows = 0;
    let removedDenseRows = 0;
    let removedAnnRows = 0;
    let removedTermRows = 0;
    if (candidates.length > 0) {
      const removeEmbedding = this.database.prepare(
        'DELETE FROM memory_embeddings WHERE memory_id = ?',
      );
      const removeDense = this.database.prepare(
        'DELETE FROM memory_dense_lsh WHERE memory_id = ?',
      );
      const removeAnn = this.database.prepare(
        'DELETE FROM memory_ann_index WHERE memory_id = ?',
      );
      const removeTerm = this.database.prepare(
        'DELETE FROM memory_term_index WHERE memory_id = ?',
      );
      const insertCompaction = this.database.prepare(
        `INSERT INTO conversation_episode_compactions (
           episode_id, memory_id, summary_id, user_id, namespace,
           compacted_at, last_verified_at, removed_embedding_rows,
           removed_dense_rows, removed_ann_rows, removed_term_rows
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(episode_id) DO NOTHING`,
      );
      const stillCovered = this.database.prepare(
        `SELECT 1
         FROM conversation_memory_summary_sources source_link
         JOIN conversation_memory_summaries summary
           ON summary.id = source_link.summary_id
         JOIN memories summary_memory
           ON summary_memory.id = summary.memory_id
         WHERE source_link.episode_id = ?
           AND summary.id = ?
           AND summary.summary_type = 'week'
           AND summary.status = 'active'
           AND summary_memory.status = 'active'
         LIMIT 1`,
      );
      this.database.exec('BEGIN IMMEDIATE');
      try {
        for (const row of candidates) {
          const episodeId = cleanText(row.episode_id);
          const memoryId = cleanText(row.memory_id);
          const summaryId = cleanText(row.summary_id);
          if (!stillCovered.get(episodeId, summaryId)) continue;
          const embeddingRows = Number(
            removeEmbedding.run(memoryId).changes,
          );
          const denseRows = Number(removeDense.run(memoryId).changes);
          const annRows = Number(removeAnn.run(memoryId).changes);
          const termRows = Number(removeTerm.run(memoryId).changes);
          const inserted = insertCompaction.run(
            episodeId,
            memoryId,
            summaryId,
            cleanText(row.user_id),
            cleanText(row.namespace),
            timestamp,
            timestamp,
            embeddingRows,
            denseRows,
            annRows,
            termRows,
          );
          if (Number(inserted.changes) !== 1) continue;
          compacted += 1;
          removedEmbeddingRows += embeddingRows;
          removedDenseRows += denseRows;
          removedAnnRows += annRows;
          removedTermRows += termRows;
        }
        if (compacted > 0) {
          this.insertAudit(
            'episode_indexes_compacted',
            null,
            userId,
            {
              namespace,
              hotDays,
              hotCutoff,
              compacted,
              removedEmbeddingRows,
              removedDenseRows,
              removedAnnRows,
              removedTermRows,
              ftsRetained: true,
            },
            timestamp,
          );
        }
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
    return {
      scanned: staleRows.length + candidates.length,
      compacted,
      rehydrated,
      removedEmbeddingRows,
      removedDenseRows,
      removedAnnRows,
      removedTermRows,
      hotCutoff,
    };
  }

  runRetentionSweep(input: {
    userId?: string;
    namespace?: string;
    at?: string;
  } = {}): RetentionSweepResult {
    const userId = cleanText(input.userId, config.defaultUserId);
    const timestamp = input.at
      ? isoTimestamp(input.at)!
      : this.now();
    const where = ['i.user_id = ?', "i.status = 'active'"];
    const values: SQLInputValue[] = [userId];
    if (input.namespace) {
      where.push('i.namespace = ?');
      values.push(cleanText(input.namespace));
    }
    const rows = this.database
      .prepare(
        `SELECT
           i.*,
           m.importance,
           m.source,
           m.updated_at AS projection_updated_at
         FROM memory_items i
         JOIN memories m ON m.id = i.id
         WHERE ${where.join(' AND ')}
         ORDER BY i.updated_at ASC`,
      )
      .all(...values) as DatabaseRow[];
    const policies = this.listPolicies(userId);
    let archived = 0;
    let protectedCount = 0;

    for (const row of rows) {
      const kind = cleanText(row.kind) as MemoryKind;
      if (
        asBoolean(row.pinned) ||
        kind === 'profile' ||
        kind === 'instruction'
      ) {
        protectedCount += 1;
        continue;
      }
      const policy =
        policies.find(
          (entry) =>
            entry.namespace === cleanText(row.namespace) &&
            entry.kind === kind,
        ) ||
        policies.find(
          (entry) =>
            entry.namespace === cleanText(row.namespace) &&
            entry.kind === null,
        );
      if (policy?.autoArchive === false) continue;
      const expiresAt = asNullableText(row.expires_at);
      const expired =
        expiresAt !== null &&
        Date.parse(expiresAt) <= Date.parse(timestamp);
      // 显式策略存在时以策略为准：null 表示该 scope 不衰减（而非"未配置"
      // 而回落到默认值）。默认值本身也已是不衰减。
      const halfLifeDays = policy
        ? policy.halfLifeDays
        : DEFAULT_HALF_LIFE_DAYS[kind];
      // 不衰减的事实不会因权重跌破阈值被归档，只有显式 TTL 过期才会。
      if (!expired && halfLifeDays === null) continue;
      const ageDays = Math.max(
        0,
        Date.parse(timestamp) -
          Date.parse(cleanText(row.projection_updated_at)),
      ) / 86_400_000;
      const confirmationMultiplier =
        1 + Math.min(10, Number(row.confirmed_count)) * 0.5;
      const weight =
        halfLifeDays === null
          ? Number(row.importance)
          : Number(row.importance) *
            0.5 ** (
              ageDays /
              (halfLifeDays * confirmationMultiplier)
            );
      if (
        !expired &&
        weight >= config.retentionArchiveThreshold
      ) {
        continue;
      }
      this.archive(
        cleanText(row.id),
        userId,
        expired ? 'ttl_expired' : 'retention_decay',
        timestamp,
        weight,
      );
      archived += 1;
    }

    const refinement = this.refineEpisodeIndexes({
      userId,
      namespace: input.namespace,
      at: timestamp,
    });
    const evidenceRedacted = this.redactExpiredEvidence(
      userId,
      input.namespace,
      policies,
      timestamp,
    );
    return {
      scanned: rows.length,
      archived,
      protected: protectedCount,
      evidenceRedacted,
      episodesCompacted: refinement.compacted,
      episodesRehydrated: refinement.rehydrated,
      removedEmbeddingRows: refinement.removedEmbeddingRows,
      removedDenseRows: refinement.removedDenseRows,
      removedAnnRows: refinement.removedAnnRows,
      removedTermRows: refinement.removedTermRows,
    };
  }

  enqueueRetentionSweep(
    at = this.now(),
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
    predecessorJobId?: string,
  ): MemoryJob {
    const availableAt = isoTimestamp(at)!;
    const ownerId = cleanText(userId, config.defaultUserId);
    const targetNamespace = cleanText(
      namespace,
      config.defaultNamespace,
    );
    const bucket = availableAt.slice(0, 13);
    const id = predecessorJobId
      ? `retention-sweep:${sha256(predecessorJobId)}`
      : `retention-sweep:${ownerId}:${targetNamespace}:${bucket}`;
    return this.lifecycleStore.enqueueJob({
      id,
      jobType: 'retention_sweep',
      userId: ownerId,
      namespace: targetNamespace,
      payload: {
        userId: ownerId,
        namespace: targetNamespace,
        at: availableAt,
      },
      priority: -5,
      maxAttempts: 5,
      availableAt,
    });
  }

  ensureRetentionSweep(
    at = this.now(),
    userId = config.defaultUserId,
    namespace = config.defaultNamespace,
  ): MemoryJob {
    const ownerId = cleanText(userId, config.defaultUserId);
    const targetNamespace = cleanText(
      namespace,
      config.defaultNamespace,
    );
    const timestamp = isoTimestamp(at)!;
    const currentTimestamp = this.now();
    const nowMs = Date.parse(currentTimestamp);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database
        .prepare(
          `SELECT id, status, attempts, max_attempts, lease_until,
                  available_at, created_at
           FROM memory_jobs
           WHERE job_type = 'retention_sweep'
             AND user_id = ? AND namespace = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(ownerId, targetNamespace) as DatabaseRow[];
      const activeRows = rows
        .filter((row) => {
          const status = cleanText(row.status);
          const attempts = Number(row.attempts);
          const maxAttempts = Number(row.max_attempts);
          if (
            (status === 'pending' || status === 'failed') &&
            attempts < maxAttempts
          ) {
            return true;
          }
          if (status !== 'running') return false;
          if (attempts < maxAttempts) return true;
          const leaseUntil = asNullableText(row.lease_until);
          return Boolean(
            leaseUntil && Date.parse(leaseUntil) > nowMs,
          );
        })
        .sort(
          (left, right) =>
            cleanText(left.available_at).localeCompare(
              cleanText(right.available_at),
            ) ||
            cleanText(left.created_at).localeCompare(
              cleanText(right.created_at),
            ) ||
            cleanText(left.id).localeCompare(cleanText(right.id)),
        );
      const leased = activeRows.find((row) => {
        if (cleanText(row.status) !== 'running') return false;
        const leaseUntil = asNullableText(row.lease_until);
        return Boolean(
          leaseUntil && Date.parse(leaseUntil) > nowMs,
        );
      });
      const selected = leased || activeRows[0];
      const keeper = selected
        ? this.lifecycleStore.getJob(cleanText(selected.id))
        : this.enqueueRetentionSweep(
            timestamp,
            ownerId,
            targetNamespace,
            rows[0] ? cleanText(rows[0].id) : undefined,
          );
      if (!keeper) throw new Error('无法建立 retention sweep 链');

      const retireDuplicate = this.database.prepare(
        `UPDATE memory_jobs
         SET status = 'completed', lease_until = NULL,
             lease_owner = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND job_type = 'retention_sweep'
           AND user_id = ? AND namespace = ?
           AND (
             status IN ('pending', 'failed')
             OR (
               status = 'running'
               AND (lease_until IS NULL OR lease_until <= ?)
             )
           )`,
      );
      for (const row of rows) {
        const duplicateId = cleanText(row.id);
        if (duplicateId === keeper.id) continue;
        retireDuplicate.run(
          `由唯一 retention sweep 链接管：${keeper.id}`,
          currentTimestamp,
          duplicateId,
          ownerId,
          targetNamespace,
          currentTimestamp,
        );
      }
      this.database.exec('COMMIT');
      return keeper;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  ensureRetentionSweepChains(
    at = this.now(),
    startupScopes: Array<{ userId: string; namespace: string }> = [],
  ): MemoryJob[] {
    const scopes = new Map<string, { userId: string; namespace: string }>();
    const addScope = (userId: unknown, namespace: unknown) => {
      const ownerId = cleanText(userId, config.defaultUserId);
      const targetNamespace = cleanText(
        namespace,
        config.defaultNamespace,
      );
      scopes.set(
        `${ownerId}\u0000${targetNamespace}`,
        { userId: ownerId, namespace: targetNamespace },
      );
    };
    for (const scope of startupScopes) {
      addScope(scope.userId, scope.namespace);
    }
    const legacyScopes = this.database
      .prepare(
        `SELECT DISTINCT user_id, namespace
         FROM memory_jobs
         WHERE job_type = 'retention_sweep'
           AND status IN ('pending', 'failed', 'running')`,
      )
      .all() as DatabaseRow[];
    for (const scope of legacyScopes) {
      addScope(scope.user_id, scope.namespace);
    }
    return [...scopes.values()].map((scope) =>
      this.ensureRetentionSweep(
        at,
        scope.userId,
        scope.namespace,
      ),
    );
  }

  queuePurge(
    memoryId: string,
    reason = '用户请求物理清除',
    userId = config.defaultUserId,
  ): PurgeJobRecord {
    const ownerId = cleanText(userId);
    const current = this.memoryStore.get(memoryId, true, ownerId);
    if (!current) {
      throw new Error('记忆不存在或不属于当前用户');
    }
    const forgotten =
      current.status === 'deleted'
        ? current
        : this.memoryStore.forget(memoryId, reason, ownerId);
    const timestamp = this.now();
    const id = `purge:${forgotten.id}:${forgotten.checksum}`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO purge_jobs (
             id, memory_id, user_id, namespace, content_hash, reason,
             available_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          id,
          forgotten.id,
          forgotten.userId,
          forgotten.namespace,
          forgotten.checksum,
          cleanText(reason, '用户请求物理清除'),
          timestamp,
          timestamp,
          timestamp,
        );
      this.lifecycleStore.enqueueJob({
        id: `physical-purge:${id}`,
        jobType: 'purge_memory',
        userId: forgotten.userId,
        namespace: forgotten.namespace,
        payload: { purgeJobId: id, memoryId: forgotten.id },
        priority: 20,
        maxAttempts: 5,
        availableAt: timestamp,
      });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.getPurgeJob(id)!;
  }

  processPurgeJob(
    purgeJobId: string,
    workerId: string,
  ): PurgeJobRecord {
    const currentJob = this.getPurgeJob(purgeJobId);
    if (!currentJob) throw new Error('物理清除任务不存在');
    if (currentJob.status === 'completed') return currentJob;
    const owner = cleanText(workerId);
    if (!owner) throw new Error('物理清除 workerId 不能为空');
    const timestamp = this.now();
    const leaseUntil = new Date(
      Date.parse(timestamp) + 120_000,
    ).toISOString();
    const claimed = this.database
      .prepare(
        `UPDATE purge_jobs
         SET status = 'running', attempts = attempts + 1,
             lease_owner = ?, lease_until = ?, last_error = NULL,
             updated_at = ?
         WHERE id = ?
           AND attempts < max_attempts
           AND (
             (status IN ('pending', 'failed') AND available_at <= ?)
             OR (
               status = 'running' AND (
                 lease_until <= ? OR lease_owner = ?
               )
             )
           )`,
      )
      .run(
        owner,
        leaseUntil,
        timestamp,
        currentJob.id,
        timestamp,
        timestamp,
        owner,
      );
    if (Number(claimed.changes) !== 1) {
      const latest = this.getPurgeJob(currentJob.id);
      if (latest?.status === 'completed') return latest;
      throw new Error('物理清除任务未取得有效内部租约');
    }
    const job = this.getPurgeJob(currentJob.id)!;
    const memoryItem = this.database
      .prepare(
        `SELECT *
         FROM memory_items
         WHERE id = ? AND user_id = ?`,
      )
      .get(job.memoryId, job.userId) as DatabaseRow | undefined;
    let mainTombstoneIds: string[] = [];
    if (memoryItem) {
      const mainTombstones = this.database
        .prepare(
          `SELECT
             t.id,
             t.restored_at
           FROM memory_tombstones t
           WHERE t.user_id = ? AND t.namespace = ?
             AND (
               t.content_hash = ?
               OR t.memory_item_id = ?
             )`,
        )
        .all(
          job.userId,
          job.namespace,
          job.contentHash,
          job.memoryId,
        ) as DatabaseRow[];
      const activeMainTombstones = mainTombstones.filter(
        (row) => row.restored_at === null,
      );
      mainTombstoneIds = uniqueText(
        mainTombstones.map((row) => row.id),
      );
      if (activeMainTombstones.length === 0) {
        throw new Error(
          '物理清除已中止：缺少有效 tombstone',
        );
      }
    }

    const managedBackups = this.purgeManagedMigrationBackups(
      job.memoryId,
      job.contentHash,
      job.userId,
      job.namespace,
    );
    if (!memoryItem) {
      prepareSecureFtsDeletion(this.database);
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.insertAudit(
          'physical_purge',
          null,
          job.userId,
          {
            purgedHash: job.contentHash,
            targetCount: 0,
            turnCount: 0,
            managedBackupsScanned: managedBackups.scanned,
            managedBackupsSanitized: managedBackups.sanitized,
            externalExportCopiesCovered: false,
          },
          timestamp,
        );
        this.sanitizePurgeRecord(
          job,
          timestamp,
          job.contentHash,
        );
        rebuildSecureFts(this.database);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
      this.checkpointPurgedWal();
      this.completePurgeRecord(job, this.now());
      return this.getPurgeJob(job.id)!;
    }

    const derivedClosure = resolveLayeredPurgeClosure(
      this.database,
      job.memoryId,
      job.userId,
      job.namespace,
    );
    const derivedRows = derivedClosure.projectionRows;
    const uniqueTargetIds = derivedClosure.memoryIds;
    const rebuildScopes = new Map<
      string,
      Record<string, unknown>
    >();
    for (const row of derivedRows) {
      const scope = projectionRebuildScope(row);
      if (!scope) continue;
      const identity = JSON.stringify([
        scope.userId,
        scope.namespace,
        scope.accessScopeType,
        scope.accessScopeKey,
        scope.scopeType,
        scope.scopeKey,
      ]);
      rebuildScopes.set(identity, scope);
    }
    const memoryPlaceholders = placeholders(uniqueTargetIds);
    const targetTombstones = this.database
      .prepare(
        `SELECT id, restored_at
         FROM memory_tombstones
         WHERE user_id = ? AND namespace = ?
           AND (
             content_hash = ?
             OR memory_item_id IN (${memoryPlaceholders})
           )`,
      )
      .all(
        job.userId,
        job.namespace,
        job.contentHash,
        ...uniqueTargetIds,
      ) as DatabaseRow[];
    mainTombstoneIds = uniqueText([
      ...mainTombstoneIds,
      ...targetTombstones.map((row) => row.id),
    ]);
    const versionRows = this.database
      .prepare(
        `SELECT id
         FROM memory_versions
         WHERE memory_item_id IN (${memoryPlaceholders})`,
      )
      .all(...uniqueTargetIds) as DatabaseRow[];
    const versionIds = versionRows.map((row) => cleanText(row.id));
    const evidenceTurnIds = versionIds.length
      ? (
          this.database
            .prepare(
              `SELECT DISTINCT turn_id
               FROM memory_evidence
               WHERE memory_version_id IN (
                 ${versionIds.map(() => '?').join(', ')}
               )
                 AND turn_id IS NOT NULL`,
            )
            .all(...versionIds) as DatabaseRow[]
        ).map((row) => cleanText(row.turn_id))
      : [];
    const turnIds = uniqueText([
      ...derivedClosure.turnIds,
      ...completedExchangeTurnIds(this.database, evidenceTurnIds),
    ]);
    const stableKeys = (
      this.database
        .prepare(
          `SELECT stable_key
           FROM memory_items
           WHERE id IN (${memoryPlaceholders})`,
        )
        .all(...uniqueTargetIds) as DatabaseRow[]
    ).map((row) => cleanText(row.stable_key));
    const candidateConditions = [
      `resolved_memory_item_id IN (${memoryPlaceholders})`,
    ];
    const candidateValues: SQLInputValue[] = [
      job.userId,
      job.namespace,
      ...uniqueTargetIds,
    ];
    if (turnIds.length > 0) {
      candidateConditions.push(
        `turn_id IN (${placeholders(turnIds)})`,
      );
      candidateValues.push(...turnIds);
    }
    if (stableKeys.length > 0) {
      candidateConditions.push(
        `normalized_key IN (${placeholders(stableKeys)})`,
      );
      candidateConditions.push(
        `stable_key IN (${placeholders(stableKeys)})`,
      );
      candidateValues.push(...stableKeys, ...stableKeys);
    }
    const directlyRelatedCandidateIds = uniqueText(
      (
        this.database
          .prepare(
            `SELECT id
             FROM memory_candidates
             WHERE user_id = ? AND namespace = ?
               AND (${candidateConditions.join(' OR ')})`,
          )
          .all(...candidateValues) as DatabaseRow[]
      ).map((row) => row.id),
    );
    const reflectionRunIds = uniqueText([
      ...(directlyRelatedCandidateIds.length > 0
        ? (
            this.database.prepare(
              `SELECT reflection_run_id
               FROM memory_candidates
               WHERE id IN (${placeholders(directlyRelatedCandidateIds)})
                 AND reflection_run_id IS NOT NULL`,
            ).all(...directlyRelatedCandidateIds) as DatabaseRow[]
          ).map((row) => row.reflection_run_id)
        : []),
      ...(turnIds.length > 0
        ? (
            this.database.prepare(
              `SELECT DISTINCT run_id
               FROM memory_reflection_run_turns
               WHERE turn_id IN (${placeholders(turnIds)})`,
            ).all(...turnIds) as DatabaseRow[]
          ).map((row) => row.run_id)
        : []),
    ]);
    const reflectionRunRows = reflectionRunIds.length > 0
      ? this.database.prepare(
          `SELECT id, user_id, namespace, scope_type, scope_key,
                  run_type, generation_key
           FROM memory_reflection_runs
           WHERE id IN (${placeholders(reflectionRunIds)})`,
        ).all(...reflectionRunIds) as DatabaseRow[]
      : [];
    if (
      reflectionRunRows.length !== reflectionRunIds.length ||
      reflectionRunRows.some(
        (row) =>
          cleanText(row.user_id) !== job.userId ||
          cleanText(row.namespace) !== job.namespace,
      )
    ) {
      throw new Error(
        '物理清除已中止：关联 reflection run 无法证明租户归属',
      );
    }
    const candidateIds = uniqueText([
      ...directlyRelatedCandidateIds,
      ...(reflectionRunIds.length > 0
        ? (
            this.database.prepare(
              `SELECT id
               FROM memory_candidates
               WHERE user_id = ? AND namespace = ?
                 AND reflection_run_id IN (
                   ${placeholders(reflectionRunIds)}
                 )`,
            ).all(
              job.userId,
              job.namespace,
              ...reflectionRunIds,
            ) as DatabaseRow[]
          ).map((row) => row.id)
        : []),
    ]);
    const eventConditions = [
      `memory_item_id IN (${memoryPlaceholders})`,
      ...uniqueTargetIds.map(() => 'payload_json LIKE ?'),
    ];
    const eventIds = uniqueText(
      (
        this.database
          .prepare(
            `SELECT id
             FROM memory_events
             WHERE user_id = ?
               AND (${eventConditions.join(' OR ')})`,
          )
          .all(
            job.userId,
            ...uniqueTargetIds,
            ...uniqueTargetIds.map((id) => `%${id}%`),
          ) as DatabaseRow[]
      ).map((row) => row.id),
    );
    const auditHash = sha256([
      job.contentHash,
      ...[...uniqueTargetIds].sort(),
    ].join('\n'));

    prepareSecureFtsDeletion(this.database);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      // Main-database backfill shares the destructive transaction:
      // no hash-only protection can commit unless every deletion does.
      backfillTombstoneSemanticFingerprints(this.database, {
        tombstoneIds: mainTombstoneIds,
        requireComplete: true,
      });
      const actionConditions = [
        `target_memory_id IN (${memoryPlaceholders})`,
        ...uniqueTargetIds.map(() => 'candidate_json LIKE ?'),
      ];
      const actionValues: SQLInputValue[] = [
        ...uniqueTargetIds,
        ...uniqueTargetIds.map((id) => `%${id}%`),
      ];
      if (candidateIds.length > 0) {
        actionConditions.push(
          `candidate_id IN (${placeholders(candidateIds)})`,
        );
        actionValues.push(...candidateIds);
      }
      if (turnIds.length > 0) {
        actionConditions.push(
          `turn_id IN (${placeholders(turnIds)})`,
        );
        actionValues.push(...turnIds);
      }
      const actionRequestResult = this.database
        .prepare(
          `UPDATE memory_action_requests
           SET status = CASE
                 WHEN status IN ('pending', 'failed')
                   THEN 'rejected'
                 ELSE status
               END,
               target_query = '[purged]',
               target_memory_id = NULL,
               candidate_id = NULL,
               turn_id = NULL,
               candidate_json = NULL,
               rationale = 'physical_purge',
               error = NULL,
               review_token = NULL,
               review_claimed_at = NULL,
               resolved_at = COALESCE(resolved_at, ?)
           WHERE user_id = ?
             AND (${actionConditions.join(' OR ')})`,
        )
        .run(timestamp, job.userId, ...actionValues);

      for (const [identity, scope] of rebuildScopes) {
        this.lifecycleStore.enqueueJob({
          id: `consolidate-purge:${sha256([
            job.id,
            identity,
          ].join('\0'))}`,
          jobType: 'consolidate_scope',
          userId: cleanText(scope.userId),
          namespace: cleanText(scope.namespace),
          payload: {
            ...scope,
            trigger: 'physical_purge',
            purgeJobId: job.id,
          },
          priority: 2,
          maxAttempts: 5,
          availableAt: timestamp,
        });
      }
      for (const row of derivedRows) {
        this.database
          .prepare(
            'DELETE FROM derived_consolidations WHERE id = ?',
          )
          .run(cleanText(row.id));
      }
      const reflectionClaimConditions: string[] = [];
      const reflectionClaimValues: SQLInputValue[] = [];
      if (candidateIds.length > 0) {
        reflectionClaimConditions.push(
          `candidate_id IN (${placeholders(candidateIds)})`,
        );
        reflectionClaimValues.push(...candidateIds);
      }
      if (reflectionRunIds.length > 0) {
        reflectionClaimConditions.push(
          `first_run_id IN (${placeholders(reflectionRunIds)})`,
          `last_run_id IN (${placeholders(reflectionRunIds)})`,
        );
        reflectionClaimValues.push(
          ...reflectionRunIds,
          ...reflectionRunIds,
        );
      }
      if (reflectionClaimConditions.length > 0) {
        this.database.prepare(
          `DELETE FROM memory_reflection_claims
           WHERE user_id = ? AND namespace = ?
             AND (${reflectionClaimConditions.join(' OR ')})`,
        ).run(
          job.userId,
          job.namespace,
          ...reflectionClaimValues,
        );
      }
      const candidateEvidenceConditions: string[] = [];
      const candidateEvidenceValues: SQLInputValue[] = [];
      if (candidateIds.length > 0) {
        candidateEvidenceConditions.push(
          `candidate_id IN (${placeholders(candidateIds)})`,
        );
        candidateEvidenceValues.push(...candidateIds);
      }
      if (turnIds.length > 0) {
        candidateEvidenceConditions.push(
          `turn_id IN (${placeholders(turnIds)})`,
        );
        candidateEvidenceValues.push(...turnIds);
      }
      if (candidateEvidenceConditions.length > 0) {
        this.database.prepare(
          `DELETE FROM memory_candidate_evidence
           WHERE user_id = ? AND namespace = ?
             AND (${candidateEvidenceConditions.join(' OR ')})`,
        ).run(
          job.userId,
          job.namespace,
          ...candidateEvidenceValues,
        );
      }
      if (candidateIds.length > 0) {
        this.database
          .prepare(
            `DELETE FROM memory_candidates
             WHERE user_id = ? AND namespace = ?
               AND id IN (${placeholders(candidateIds)})`,
          )
          .run(job.userId, job.namespace, ...candidateIds);
      }
      if (reflectionRunIds.length > 0) {
        this.database.prepare(
          `DELETE FROM memory_reflection_runs
           WHERE user_id = ? AND namespace = ?
             AND id IN (${placeholders(reflectionRunIds)})`,
        ).run(
          job.userId,
          job.namespace,
          ...reflectionRunIds,
        );
      }
      for (const row of reflectionRunRows) {
        this.database.prepare(
          `UPDATE memory_reflection_checkpoints
           SET last_ingest_seq = 0,
               last_turn_occurred_at = NULL,
               last_turn_id = NULL,
               last_success_at = NULL,
               updated_at = ?
           WHERE user_id = ? AND namespace = ?
             AND scope_type = ? AND scope_key = ?
             AND run_type = ? AND generation_key = ?`,
        ).run(
          timestamp,
          job.userId,
          job.namespace,
          cleanText(row.scope_type),
          cleanText(row.scope_key),
          cleanText(row.run_type),
          cleanText(row.generation_key),
        );
      }
      if (turnIds.length > 0) {
        this.database.prepare(
          `UPDATE memory_reflection_checkpoints
           SET last_ingest_seq = 0,
               last_turn_occurred_at = NULL,
               last_turn_id = NULL,
               last_success_at = NULL,
               updated_at = ?
           WHERE user_id = ? AND namespace = ?
             AND last_turn_id IN (${placeholders(turnIds)})`,
        ).run(
          timestamp,
          job.userId,
          job.namespace,
          ...turnIds,
        );
      }

      sanitizeConversationTurnArtifacts(
        this.database,
        turnIds,
        job.userId,
        job.namespace,
        timestamp,
        auditHash,
      );
      if (turnIds.length > 0) {
        this.database.prepare(
          `DELETE FROM memory_pattern_observations
           WHERE user_id = ? AND namespace = ?
             AND turn_id IN (${placeholders(turnIds)})`,
        ).run(job.userId, job.namespace, ...turnIds);
      }

      for (const memoryId of uniqueTargetIds) {
        this.sanitizeAudit(memoryId, job.userId, auditHash);
      }
      if (eventIds.length > 0) {
        this.database
          .prepare(
            `UPDATE memory_events
             SET memory_item_id = NULL,
                 payload_json = ?
             WHERE id IN (${placeholders(eventIds)})`,
          )
          .run(
            JSON.stringify({ purgedHash: auditHash }),
            ...eventIds,
          );
      }
      const outboxConditions = [
        ...uniqueTargetIds.map(() => 'payload_json LIKE ?'),
      ];
      const outboxValues: SQLInputValue[] = uniqueTargetIds.map(
        (id) => `%${id}%`,
      );
      if (eventIds.length > 0) {
        outboxConditions.unshift(
          `aggregate_id IN (${placeholders(eventIds)})`,
        );
        outboxValues.unshift(...eventIds);
      }
      deleteLayeredPurgeRows(
        this.database,
        derivedClosure,
        job.userId,
        job.namespace,
      );
      this.database
        .prepare(
          `UPDATE outbox_events
           SET payload_json = ?,
               status = 'completed',
               lease_until = NULL,
               lease_owner = NULL,
               last_error = NULL,
               processed_at = COALESCE(processed_at, ?),
               updated_at = ?
           WHERE aggregate_type = 'memory_event'
             AND user_id = ?
             AND namespace = ?
             AND (${outboxConditions.join(' OR ')})`,
        )
        .run(
          JSON.stringify({ purgedHash: auditHash }),
          timestamp,
          timestamp,
          job.userId,
          job.namespace,
          ...outboxValues,
        );

      this.database
        .prepare(
          `DELETE FROM memories
           WHERE id IN (${memoryPlaceholders})`,
        )
        .run(...uniqueTargetIds);
      this.database
        .prepare(
          `DELETE FROM memory_items
           WHERE id IN (${memoryPlaceholders})`,
        )
        .run(...uniqueTargetIds);
      assertProjectionReferencesCleared(
        this.database,
        derivedClosure.projectionIds,
        '主数据库物理清除后',
      );
      rebuildSecureFts(this.database);
      this.database
        .prepare(
          `UPDATE memory_tombstones
           SET memory_item_id = NULL,
               stable_key = NULL,
               normalized_key = NULL,
               normalized_value = NULL,
               reason = ?
           WHERE id IN (${placeholders(mainTombstoneIds)})
             AND user_id = ? AND namespace = ?`,
        )
        .run(
          `purged:${sha256(job.reason)}`,
          ...mainTombstoneIds,
          job.userId,
          job.namespace,
        );
      this.insertAudit(
        'physical_purge',
        null,
        job.userId,
        {
          purgedHash: auditHash,
          targetCount: uniqueTargetIds.length,
          turnCount: turnIds.length,
          actionRequestCount: Number(
            actionRequestResult.changes,
          ),
          managedBackupsScanned: managedBackups.scanned,
          managedBackupsSanitized: managedBackups.sanitized,
          externalExportCopiesCovered: false,
        },
        timestamp,
      );
      this.sanitizePurgeRecord(job, timestamp, auditHash);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    this.checkpointPurgedWal();
    this.completePurgeRecord(job, this.now(), auditHash);
    return this.getPurgeJob(job.id)!;
  }

  failPurgeJob(
    purgeJobId: string,
    error: string,
    workerId: string,
  ): void {
    const job = this.getPurgeJob(purgeJobId);
    if (!job || job.status === 'completed') return;
    const owner = cleanText(workerId);
    if (!owner || job.leaseOwner !== owner) return;
    const dead = job.attempts >= job.maxAttempts;
    this.database
      .prepare(
        `UPDATE purge_jobs
         SET status = ?, lease_until = NULL, lease_owner = NULL,
             last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'
           AND lease_owner = ? AND attempts = ?`,
      )
      .run(
        dead ? 'dead' : 'failed',
        cleanText(error, '未知错误'),
        this.now(),
        job.id,
        owner,
        job.attempts,
      );
  }

  getPurgeJob(
    purgeJobId: string,
    userId?: string,
    namespace?: string,
  ): PurgeJobRecord | null {
    if ((userId === undefined) !== (namespace === undefined)) {
      throw new Error(
        'getPurgeJob 必须同时提供 userId 和 namespace',
      );
    }
    const row = this.database
      .prepare(
        `SELECT *
         FROM purge_jobs
         WHERE id = ?
           ${userId === undefined
             ? ''
             : 'AND user_id = ? AND namespace = ?'}`,
      )
      .get(
        cleanText(purgeJobId),
        ...(
          userId === undefined
            ? []
            : [cleanText(userId), cleanText(namespace)]
        ),
      ) as DatabaseRow | undefined;
    return row ? rowToPurgeJob(row) : null;
  }

  listPurgeJobs(
    userId = config.defaultUserId,
    limit = 100,
  ): PurgeJobRecord[] {
    return (
      this.database
        .prepare(
          `SELECT *
           FROM purge_jobs
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(
          cleanText(userId),
          Math.max(1, Math.min(limit, 500)),
      ) as DatabaseRow[]
    ).map(rowToPurgeJob);
  }

  private purgeManagedMigrationBackups(
    memoryId: string,
    contentHash: string,
    userId: string,
    namespace: string,
  ): ManagedBackupPurgeResult {
    const backupPaths = this.managedMigrationBackupPaths();
    let sanitized = 0;
    for (const backupPath of backupPaths) {
      const backup = new DatabaseSync(backupPath);
      try {
        backup.exec('PRAGMA busy_timeout = 5000;');
        backup.exec('PRAGMA foreign_keys = ON;');
        if (
          this.purgeManagedBackup(
            backup,
            memoryId,
            contentHash,
            userId,
            namespace,
          )
        ) {
          sanitized += 1;
        }
      } finally {
        backup.close();
      }
    }
    return { scanned: backupPaths.length, sanitized };
  }

  private managedMigrationBackupPaths(): string[] {
    const main = (
      this.database
        .prepare('PRAGMA database_list')
        .all() as DatabaseRow[]
    ).find((row) => cleanText(row.name) === 'main');
    const databaseFile = asNullableText(main?.file);
    if (!databaseFile || databaseFile === ':memory:') return [];

    const resolvedDatabase = path.resolve(databaseFile);
    const directory = path.join(
      path.dirname(resolvedDatabase),
      'migration-backups',
    );
    const directoryStats = fs.existsSync(directory)
      ? fs.lstatSync(directory)
      : null;
    if (
      !directoryStats ||
      directoryStats.isSymbolicLink() ||
      !directoryStats.isDirectory()
    ) {
      return [];
    }
    const extension = path.extname(resolvedDatabase);
    const suffix = extension || '.sqlite3';
    const prefix =
      `${path.basename(resolvedDatabase, extension)}-schema-`;
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(prefix) &&
          entry.name.endsWith(suffix),
      )
      .map((entry) => path.join(directory, entry.name))
      .sort();
  }

  private purgeManagedBackup(
    backup: DatabaseSync,
    memoryId: string,
    contentHash: string,
    userId: string,
    namespace: string,
  ): boolean {
    const rootId = cleanText(memoryId);
    const ownerId = cleanText(userId);
    const scopedNamespace = cleanText(namespace);
    const timestamp = this.now();
    const derivedClosure = resolveLayeredPurgeClosure(
      backup,
      rootId,
      ownerId,
      scopedNamespace,
    );
    const derivedRows = derivedClosure.projectionRows;
    const uniqueTargetIds = derivedClosure.memoryIds;
    const memoryPlaceholders = placeholders(uniqueTargetIds);
    const versionColumns = tableColumns(
      backup,
      'memory_versions',
    );
    const versionIds =
      versionColumns.has('id') &&
      versionColumns.has('memory_item_id')
        ? uniqueText(
            (
              backup
                .prepare(
                  `SELECT id
                   FROM memory_versions
                   WHERE memory_item_id IN (${memoryPlaceholders})`,
                )
                .all(...uniqueTargetIds) as DatabaseRow[]
            ).map((row) => row.id),
          )
        : [];
    const evidenceColumns = tableColumns(
      backup,
      'memory_evidence',
    );
    const evidenceTurnIds =
      versionIds.length > 0 &&
      evidenceColumns.has('memory_version_id') &&
      evidenceColumns.has('turn_id')
        ? uniqueText(
            (
              backup
                .prepare(
                  `SELECT DISTINCT turn_id
                   FROM memory_evidence
                   WHERE memory_version_id IN (
                     ${placeholders(versionIds)}
                   )
                     AND turn_id IS NOT NULL`,
                )
                .all(...versionIds) as DatabaseRow[]
            ).map((row) => row.turn_id),
          )
        : [];
    const turnIds = uniqueText([
      ...derivedClosure.turnIds,
      ...completedExchangeTurnIds(backup, evidenceTurnIds),
    ]);
    const itemColumns = tableColumns(backup, 'memory_items');
    const stableKeys =
      itemColumns.has('id') && itemColumns.has('stable_key')
        ? uniqueText(
            (
              backup
                .prepare(
                  `SELECT stable_key
                   FROM memory_items
                   WHERE id IN (${memoryPlaceholders})`,
                )
                .all(...uniqueTargetIds) as DatabaseRow[]
            ).map((row) => row.stable_key),
          )
        : [];

    let tombstoneColumns = tableColumns(
      backup,
      'memory_tombstones',
    );
    if (
      tombstoneColumns.size > 0 &&
      (
        !tombstoneColumns.has('user_id') ||
        !tombstoneColumns.has('namespace')
      )
    ) {
      throw new Error(
        '系统受管迁移备份清除已中止：memory_tombstones 缺少租户作用域',
      );
    }
    const tombstoneConditions: string[] = [];
    const tombstoneMatchValues: SQLInputValue[] = [];
    if (tombstoneColumns.has('memory_item_id')) {
      tombstoneConditions.push(
        `memory_item_id IN (${memoryPlaceholders})`,
      );
      tombstoneMatchValues.push(...uniqueTargetIds);
    }
    if (tombstoneColumns.has('content_hash')) {
      tombstoneConditions.push('content_hash = ?');
      tombstoneMatchValues.push(contentHash);
    }
    const tombstoneScopeClause =
      'user_id = ? AND namespace = ?';
    const tombstoneValues: SQLInputValue[] = [
      ownerId,
      scopedNamespace,
      ...tombstoneMatchValues,
    ];
    const tombstoneIdentityRows =
      tombstoneConditions.length > 0 &&
      tombstoneColumns.has('id')
        ? backup
            .prepare(
              `SELECT
                 id,
                 ${
                tombstoneColumns.has('restored_at')
                  ? 'restored_at'
                  : 'NULL AS restored_at'
              }
               FROM memory_tombstones
               WHERE ${tombstoneScopeClause}
                 AND (${tombstoneConditions.join(' OR ')})`,
            )
            .all(...tombstoneValues) as DatabaseRow[]
        : [];
    const tombstoneIds = uniqueText(
      tombstoneIdentityRows.map((row) => row.id),
    );
    // Fingerprint backfill can rewrite rows that still contain purge
    // plaintext. Enable secure deletion before that first write so an
    // older cell image cannot survive in a database page.
    prepareSecureFtsDeletion(backup);
    // A managed backup has its own commit boundary. This first
    // transaction only adds/repairs irreversible fingerprints; it is
    // safe to retain if the later destructive transaction aborts, and
    // the same input deterministically makes retries idempotent.
    backup.exec('BEGIN IMMEDIATE');
    try {
      backfillTombstoneSemanticFingerprints(backup, {
        tombstoneIds,
        ensureColumns: true,
      });
      backfillTombstoneSemanticFingerprints(backup, {
        tombstoneIds,
        requireComplete: true,
      });
      backup.exec('COMMIT');
    } catch (error) {
      backup.exec('ROLLBACK');
      throw error;
    }
    tombstoneColumns = tableColumns(
      backup,
      'memory_tombstones',
    );
    const tombstoneRows = tombstoneIds.length > 0
      ? backup
          .prepare(
            `SELECT id
             FROM memory_tombstones
             WHERE id IN (${placeholders(tombstoneIds)})
               AND user_id = ? AND namespace = ?`,
          )
          .all(
            ...tombstoneIds,
            ownerId,
            scopedNamespace,
          ) as DatabaseRow[]
      : [];

    const candidateColumns = tableColumns(
      backup,
      'memory_candidates',
    );
    if (
      candidateColumns.size > 0 &&
      (
        !candidateColumns.has('user_id') ||
        !candidateColumns.has('namespace')
      )
    ) {
      throw new Error(
        '系统受管迁移备份清除已中止：memory_candidates 缺少租户作用域',
      );
    }
    const candidateConditions: string[] = [];
    const candidateMatchValues: SQLInputValue[] = [];
    if (candidateColumns.has('resolved_memory_item_id')) {
      candidateConditions.push(
        `resolved_memory_item_id IN (${memoryPlaceholders})`,
      );
      candidateMatchValues.push(...uniqueTargetIds);
    }
    if (turnIds.length > 0 && candidateColumns.has('turn_id')) {
      candidateConditions.push(
        `turn_id IN (${placeholders(turnIds)})`,
      );
      candidateMatchValues.push(...turnIds);
    }
    for (const keyColumn of ['normalized_key', 'stable_key']) {
      if (
        stableKeys.length > 0 &&
        candidateColumns.has(keyColumn)
      ) {
        candidateConditions.push(
          `${keyColumn} IN (${placeholders(stableKeys)})`,
        );
        candidateMatchValues.push(...stableKeys);
      }
    }
    const candidateValues: SQLInputValue[] = [
      ownerId,
      scopedNamespace,
      ...candidateMatchValues,
    ];
    let candidateIds =
      candidateConditions.length > 0 && candidateColumns.has('id')
        ? uniqueText(
            (
              backup
                .prepare(
                  `SELECT id
                   FROM memory_candidates
                   WHERE user_id = ? AND namespace = ?
                     AND (${candidateConditions.join(' OR ')})`,
                )
                .all(...candidateValues) as DatabaseRow[]
            ).map((row) => row.id),
          )
        : [];
    const candidateEvidenceColumns = tableColumns(
      backup,
      'memory_candidate_evidence',
    );
    if (
      candidateEvidenceColumns.size > 0 &&
      (
        !candidateEvidenceColumns.has('candidate_id') ||
        !candidateEvidenceColumns.has('turn_id')
      )
    ) {
      throw new Error(
        '系统受管迁移备份清除已中止：candidate evidence 缺少引用边界',
      );
    }
    if (
      turnIds.length > 0 &&
      candidateEvidenceColumns.has('candidate_id') &&
      candidateEvidenceColumns.has('turn_id') &&
      candidateColumns.has('id')
    ) {
      const evidenceCandidateIds = uniqueText(
        (
          backup.prepare(
            `SELECT DISTINCT c.id
             FROM memory_candidate_evidence e
             JOIN memory_candidates c ON c.id = e.candidate_id
             WHERE c.user_id = ? AND c.namespace = ?
               AND e.turn_id IN (${placeholders(turnIds)})`,
          ).all(
            ownerId,
            scopedNamespace,
            ...turnIds,
          ) as DatabaseRow[]
        ).map((row) => row.id),
      );
      candidateIds = uniqueText([
        ...candidateIds,
        ...evidenceCandidateIds,
      ]);
    }
    const reflectionRunColumns = tableColumns(
      backup,
      'memory_reflection_runs',
    );
    if (
      reflectionRunColumns.size > 0 &&
      ['id', 'user_id', 'namespace', 'scope_type', 'scope_key'].some(
        (column) => !reflectionRunColumns.has(column),
      )
    ) {
      throw new Error(
        '系统受管迁移备份清除已中止：reflection run 缺少租户作用域',
      );
    }
    const reflectionRunTurnColumns = tableColumns(
      backup,
      'memory_reflection_run_turns',
    );
    if (
      reflectionRunTurnColumns.size > 0 &&
      (
        !reflectionRunTurnColumns.has('run_id') ||
        !reflectionRunTurnColumns.has('turn_id')
      )
    ) {
      throw new Error(
        '系统受管迁移备份清除已中止：reflection run-turn 缺少引用边界',
      );
    }
    let reflectionRunIds: string[] = [];
    if (
      candidateIds.length > 0 &&
      candidateColumns.has('reflection_run_id')
    ) {
      reflectionRunIds = uniqueText(
        (
          backup.prepare(
            `SELECT reflection_run_id
             FROM memory_candidates
             WHERE user_id = ? AND namespace = ?
               AND id IN (${placeholders(candidateIds)})
               AND reflection_run_id IS NOT NULL`,
          ).all(
            ownerId,
            scopedNamespace,
            ...candidateIds,
          ) as DatabaseRow[]
        ).map((row) => row.reflection_run_id),
      );
    }
    if (
      turnIds.length > 0 &&
      reflectionRunColumns.has('id') &&
      reflectionRunTurnColumns.has('run_id') &&
      reflectionRunTurnColumns.has('turn_id')
    ) {
      const runIdsFromTurns = uniqueText(
        (
          backup.prepare(
            `SELECT DISTINCT r.id
             FROM memory_reflection_run_turns rt
             JOIN memory_reflection_runs r ON r.id = rt.run_id
             WHERE r.user_id = ? AND r.namespace = ?
               AND rt.turn_id IN (${placeholders(turnIds)})`,
          ).all(
            ownerId,
            scopedNamespace,
            ...turnIds,
          ) as DatabaseRow[]
        ).map((row) => row.id),
      );
      reflectionRunIds = uniqueText([
        ...reflectionRunIds,
        ...runIdsFromTurns,
      ]);
    }
    const reflectionRunRows = reflectionRunIds.length > 0
      ? backup.prepare(
          `SELECT * FROM memory_reflection_runs
           WHERE id IN (${placeholders(reflectionRunIds)})`,
        ).all(...reflectionRunIds) as DatabaseRow[]
      : [];
    if (
      reflectionRunRows.length !== reflectionRunIds.length ||
      reflectionRunRows.some(
        (row) =>
          cleanText(row.user_id) !== ownerId ||
          cleanText(row.namespace) !== scopedNamespace,
      )
    ) {
      throw new Error(
        '系统受管迁移备份清除已中止：关联 reflection run 无法证明租户归属',
      );
    }
    if (
      reflectionRunIds.length > 0 &&
      candidateColumns.has('reflection_run_id')
    ) {
      const ambiguousCandidateCount = Number(
        backup.prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates
           WHERE reflection_run_id IN (${placeholders(reflectionRunIds)})
             AND (user_id != ? OR namespace != ?)`,
        ).get(
          ...reflectionRunIds,
          ownerId,
          scopedNamespace,
        )?.count || 0,
      );
      if (ambiguousCandidateCount > 0) {
        throw new Error(
          '系统受管迁移备份清除已中止：reflection candidate 租户错配',
        );
      }
      candidateIds = uniqueText([
        ...candidateIds,
        ...(
          backup.prepare(
            `SELECT id
             FROM memory_candidates
             WHERE user_id = ? AND namespace = ?
               AND reflection_run_id IN (${placeholders(reflectionRunIds)})`,
          ).all(
            ownerId,
            scopedNamespace,
            ...reflectionRunIds,
          ) as DatabaseRow[]
        ).map((row) => cleanText(row.id)),
      ]);
    }

    const actionColumns = tableColumns(
      backup,
      'memory_action_requests',
    );
    if (
      actionColumns.size > 0 &&
      (
        !actionColumns.has('id') ||
        !actionColumns.has('user_id') ||
        !actionColumns.has('namespace')
      )
    ) {
      throw new Error(
        '系统受管迁移备份清除已中止：memory_action_requests 缺少租户作用域',
      );
    }
    const actionConditions: string[] = [];
    const actionMatchValues: SQLInputValue[] = [];
    if (actionColumns.has('target_memory_id')) {
      actionConditions.push(
        `target_memory_id IN (${memoryPlaceholders})`,
      );
      actionMatchValues.push(...uniqueTargetIds);
    }
    if (
      candidateIds.length > 0 &&
      actionColumns.has('candidate_id')
    ) {
      actionConditions.push(
        `candidate_id IN (${placeholders(candidateIds)})`,
      );
      actionMatchValues.push(...candidateIds);
    }
    if (turnIds.length > 0 && actionColumns.has('turn_id')) {
      actionConditions.push(
        `turn_id IN (${placeholders(turnIds)})`,
      );
      actionMatchValues.push(...turnIds);
    }
    if (actionColumns.has('candidate_json')) {
      for (const id of uniqueTargetIds) {
        actionConditions.push('candidate_json LIKE ?');
        actionMatchValues.push(`%${id}%`);
      }
    }
    const actionIds =
      actionConditions.length > 0 && actionColumns.has('id')
        ? uniqueText(
            (
              backup
                .prepare(
                  `SELECT id
                   FROM memory_action_requests
                   WHERE user_id = ? AND namespace = ?
                     AND (${actionConditions.join(' OR ')})`,
                )
                .all(
                  ownerId,
                  scopedNamespace,
                  ...actionMatchValues,
                ) as DatabaseRow[]
            ).map((row) => row.id),
          )
        : [];

    const eventColumns = tableColumns(backup, 'memory_events');
    if (
      eventColumns.size > 0 &&
      (
        !eventColumns.has('id') ||
        !eventColumns.has('user_id') ||
        !eventColumns.has('memory_item_id') ||
        !itemColumns.has('id') ||
        !itemColumns.has('user_id') ||
        !itemColumns.has('namespace')
      )
    ) {
      throw new Error(
        '系统受管迁移备份清除已中止：memory_events 缺少可信租户作用域',
      );
    }
    const eventConditions: string[] = [];
    const eventMatchValues: SQLInputValue[] = [];
    if (eventColumns.has('memory_item_id')) {
      eventConditions.push(
        `memory_item_id IN (${memoryPlaceholders})`,
      );
      eventMatchValues.push(...uniqueTargetIds);
    }
    if (eventColumns.has('payload_json')) {
      for (const id of uniqueTargetIds) {
        eventConditions.push('payload_json LIKE ?');
        eventMatchValues.push(`%${id}%`);
      }
    }
    const eventScopeClause = `EXISTS (
      SELECT 1
      FROM memory_items scoped_event_item
      WHERE scoped_event_item.id = memory_events.memory_item_id
        AND scoped_event_item.user_id = ?
        AND scoped_event_item.namespace = ?
    )`;
    const ambiguousEventCount =
      eventConditions.length > 0 && eventColumns.has('id')
        ? Number(
            backup
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM memory_events
                 WHERE user_id = ?
                   AND (${eventConditions.join(' OR ')})
                   AND NOT EXISTS (
                     SELECT 1
                     FROM memory_items linked_event_item
                     WHERE linked_event_item.id =
                       memory_events.memory_item_id
                       AND linked_event_item.user_id =
                         memory_events.user_id
                   )`,
              )
              .get(ownerId, ...eventMatchValues)?.count || 0,
          )
        : 0;
    if (ambiguousEventCount > 0) {
      throw new Error(
        '系统受管迁移备份清除已中止：memory_events 无法证明 namespace',
      );
    }
    const eventIds =
      eventConditions.length > 0 && eventColumns.has('id')
        ? uniqueText(
            (
              backup
                .prepare(
                  `SELECT id
                   FROM memory_events
                   WHERE user_id = ?
                     AND ${eventScopeClause}
                     AND (${eventConditions.join(' OR ')})`,
                )
                .all(
                  ownerId,
                  ownerId,
                  scopedNamespace,
                  ...eventMatchValues,
                ) as DatabaseRow[]
            ).map((row) => row.id),
          )
        : [];

    const directMatches =
      this.countBackupMatches(
        backup,
        'memories',
        'id',
        uniqueTargetIds,
      ) +
      this.countBackupMatches(
        backup,
        'memory_items',
        'id',
        uniqueTargetIds,
      );
    const affected =
      directMatches +
      derivedRows.length +
      versionIds.length +
      turnIds.length +
      candidateIds.length +
      reflectionRunIds.length +
      actionIds.length +
      eventIds.length +
      tombstoneRows.length;
    if (affected === 0) {
      backup.exec('BEGIN IMMEDIATE');
      try {
        rebuildSecureFts(backup);
        backup.exec('COMMIT');
      } catch (error) {
        backup.exec('ROLLBACK');
        throw error;
      }
      checkpointTruncate(backup, '系统受管迁移备份');
      return false;
    }

    const auditHash = sha256([
      contentHash,
      ...[...uniqueTargetIds].sort(),
    ].join('\n'));
    backup.exec('BEGIN IMMEDIATE');
    try {
      if (actionIds.length > 0) {
        const assignments: string[] = [];
        const assignmentValues: SQLInputValue[] = [];
        if (actionColumns.has('status')) {
          assignments.push(
            `status = CASE
               WHEN status IN ('pending', 'failed')
                 THEN 'rejected'
               ELSE status
             END`,
          );
        }
        for (const column of [
          'target_memory_id',
          'candidate_id',
          'turn_id',
          'candidate_json',
          'error',
          'review_token',
          'review_claimed_at',
        ]) {
          if (actionColumns.has(column)) {
            assignments.push(`${column} = NULL`);
          }
        }
        if (actionColumns.has('target_query')) {
          assignments.push(`target_query = '[purged]'`);
        }
        if (actionColumns.has('rationale')) {
          assignments.push(`rationale = 'physical_purge'`);
        }
        if (actionColumns.has('resolved_at')) {
          assignments.push(
            'resolved_at = COALESCE(resolved_at, ?)',
          );
          assignmentValues.push(timestamp);
        }
        backup
          .prepare(
            `UPDATE memory_action_requests
             SET ${assignments.join(', ')}
             WHERE user_id = ? AND namespace = ?
               AND id IN (${placeholders(actionIds)})`,
          )
          .run(
            ...assignmentValues,
            ownerId,
            scopedNamespace,
            ...actionIds,
          );
      }

      sanitizeConversationTurnArtifacts(
        backup,
        turnIds,
        ownerId,
        scopedNamespace,
        timestamp,
        auditHash,
      );

      if (eventIds.length > 0) {
        const assignments: string[] = [];
        const assignmentValues: SQLInputValue[] = [];
        if (eventColumns.has('memory_item_id')) {
          assignments.push('memory_item_id = NULL');
        }
        if (eventColumns.has('payload_json')) {
          assignments.push('payload_json = ?');
          assignmentValues.push(
            JSON.stringify({ purgedHash: auditHash }),
          );
        }
        if (assignments.length > 0) {
          backup
            .prepare(
              `UPDATE memory_events
               SET ${assignments.join(', ')}
               WHERE user_id = ?
                 AND id IN (${placeholders(eventIds)})
                 AND ${eventScopeClause}`,
            )
            .run(
              ...assignmentValues,
              ownerId,
              ...eventIds,
              ownerId,
              scopedNamespace,
            );
        }
      }

      const outboxColumns = tableColumns(
        backup,
        'outbox_events',
      );
      const outboxScopeConditions: string[] = [];
      const outboxScopeValues: SQLInputValue[] = [];
      if (outboxColumns.size > 0) {
        if (
          !outboxColumns.has('aggregate_type') ||
          !outboxColumns.has('aggregate_id')
        ) {
          throw new Error(
            '系统受管迁移备份清除已中止：outbox 缺少聚合边界',
          );
        }
        outboxScopeConditions.push(
          `aggregate_type = 'memory_event'`,
        );
        if (
          outboxColumns.has('user_id') &&
          outboxColumns.has('namespace')
        ) {
          outboxScopeConditions.push('user_id = ?');
          outboxScopeConditions.push('namespace = ?');
          outboxScopeValues.push(ownerId, scopedNamespace);
        } else if (
          !outboxColumns.has('user_id') &&
          !outboxColumns.has('namespace') &&
          eventIds.length > 0
        ) {
          outboxScopeConditions.push(
            `aggregate_id IN (${placeholders(eventIds)})`,
          );
          outboxScopeValues.push(...eventIds);
        } else {
          throw new Error(
            '系统受管迁移备份清除已中止：outbox 缺少可信租户作用域',
          );
        }
      }
      const outboxConditions: string[] = [];
      const outboxConditionValues: SQLInputValue[] = [];
      if (
        eventIds.length > 0 &&
        outboxColumns.has('aggregate_id')
      ) {
        outboxConditions.push(
          `aggregate_id IN (${placeholders(eventIds)})`,
        );
        outboxConditionValues.push(...eventIds);
      }
      if (outboxColumns.has('payload_json')) {
        for (const id of uniqueTargetIds) {
          outboxConditions.push('payload_json LIKE ?');
          outboxConditionValues.push(`%${id}%`);
        }
      }
      if (
        outboxConditions.length > 0 &&
        outboxScopeConditions.length > 0 &&
        outboxColumns.has('payload_json')
      ) {
        const assignments = ['payload_json = ?'];
        const assignmentValues: SQLInputValue[] = [
          JSON.stringify({ purgedHash: auditHash }),
        ];
        if (outboxColumns.has('status')) {
          assignments.push(`status = 'completed'`);
        }
        for (const column of [
          'lease_until',
          'lease_owner',
          'last_error',
        ]) {
          if (outboxColumns.has(column)) {
            assignments.push(`${column} = NULL`);
          }
        }
        if (outboxColumns.has('processed_at')) {
          assignments.push(
            'processed_at = COALESCE(processed_at, ?)',
          );
          assignmentValues.push(timestamp);
        }
        if (outboxColumns.has('updated_at')) {
          assignments.push('updated_at = ?');
          assignmentValues.push(timestamp);
        }
        backup
          .prepare(
            `UPDATE outbox_events
             SET ${assignments.join(', ')}
             WHERE ${outboxScopeConditions.join(' AND ')}
               AND (${outboxConditions.join(' OR ')})`,
          )
          .run(
            ...assignmentValues,
            ...outboxScopeValues,
            ...outboxConditionValues,
          );
      }

      const auditColumns = tableColumns(backup, 'audit_log');
      if (auditColumns.size > 0) {
        if (
          !auditColumns.has('user_id') ||
          !auditColumns.has('memory_id') ||
          !auditColumns.has('detail_json')
        ) {
          throw new Error(
            '系统受管迁移备份清除已中止：audit_log 缺少租户作用域',
          );
        }
        const auditDetailConditions = uniqueTargetIds.map(
          () => 'detail_json LIKE ?',
        );
        const auditDetailValues = uniqueTargetIds.map(
          (id) => `%${id}%`,
        );
        const auditScopeConditions = [
          `memory_id IN (${memoryPlaceholders})`,
        ];
        const auditScopeValues: SQLInputValue[] = [
          ...uniqueTargetIds,
        ];
        const auditOwnerReferenceConditions = [
          `memory_id IN (${memoryPlaceholders})`,
        ];
        const auditOwnerReferenceValues: SQLInputValue[] = [
          ...uniqueTargetIds,
        ];
        if (
          itemColumns.has('id') &&
          itemColumns.has('user_id') &&
          itemColumns.has('namespace')
        ) {
          auditScopeConditions.push(
            `EXISTS (
               SELECT 1
               FROM memory_items scoped_audit_item
               WHERE scoped_audit_item.id = audit_log.memory_id
                 AND scoped_audit_item.user_id = ?
                 AND scoped_audit_item.namespace = ?
             )`,
          );
          auditScopeValues.push(ownerId, scopedNamespace);
          auditOwnerReferenceConditions.push(
            `EXISTS (
               SELECT 1
               FROM memory_items owner_audit_item
               WHERE owner_audit_item.id = audit_log.memory_id
                 AND owner_audit_item.user_id = ?
             )`,
          );
          auditOwnerReferenceValues.push(ownerId);
        }
        const projectionColumns = tableColumns(backup, 'memories');
        if (
          projectionColumns.has('id') &&
          projectionColumns.has('user_id') &&
          projectionColumns.has('namespace')
        ) {
          auditScopeConditions.push(
            `EXISTS (
               SELECT 1
               FROM memories scoped_audit_memory
               WHERE scoped_audit_memory.id = audit_log.memory_id
                 AND scoped_audit_memory.user_id = ?
                 AND scoped_audit_memory.namespace = ?
             )`,
          );
          auditScopeValues.push(ownerId, scopedNamespace);
          auditOwnerReferenceConditions.push(
            `EXISTS (
               SELECT 1
               FROM memories owner_audit_memory
               WHERE owner_audit_memory.id = audit_log.memory_id
                 AND owner_audit_memory.user_id = ?
             )`,
          );
          auditOwnerReferenceValues.push(ownerId);
        }
        const ambiguousAuditCount = Number(
          backup
            .prepare(
              `SELECT COUNT(*) AS count
               FROM audit_log
               WHERE user_id = ?
                 AND (${auditDetailConditions.join(' OR ')})
                 AND COALESCE((
                   ${auditOwnerReferenceConditions.join(' OR ')}
                 ), 0) = 0`,
            )
            .get(
              ownerId,
              ...auditDetailValues,
              ...auditOwnerReferenceValues,
            )?.count || 0,
        );
        if (ambiguousAuditCount > 0) {
          throw new Error(
            '系统受管迁移备份清除已中止：audit_log 无法证明 namespace',
          );
        }
        backup
          .prepare(
            `UPDATE audit_log
             SET memory_id = NULL, detail_json = ?
             WHERE user_id = ?
               AND (
                 memory_id IN (${memoryPlaceholders})
                 OR (
                   (${auditDetailConditions.join(' OR ')})
                   AND COALESCE((
                     ${auditScopeConditions.join(' OR ')}
                   ), 0) = 1
                 )
               )`,
          )
          .run(
            JSON.stringify({ purgedHash: auditHash }),
            ownerId,
            ...uniqueTargetIds,
            ...auditDetailValues,
            ...auditScopeValues,
          );
      }

      if (tombstoneRows.length > 0) {
        const assignments: string[] = [];
        const assignmentValues: SQLInputValue[] = [];
        if (tombstoneColumns.has('reason')) {
          assignments.push('reason = ?');
          assignmentValues.push(
            `purged:${sha256(contentHash)}`,
          );
        }
        if (tombstoneColumns.has('content_hash')) {
          assignments.push(
            'content_hash = COALESCE(content_hash, ?)',
          );
          assignmentValues.push(contentHash);
        }
        for (const column of [
          'memory_item_id',
          'stable_key',
          'normalized_key',
          'normalized_value',
        ]) {
          if (tombstoneColumns.has(column)) {
            assignments.push(`${column} = NULL`);
          }
        }
        if (assignments.length > 0) {
          backup
            .prepare(
              `UPDATE memory_tombstones
               SET ${assignments.join(', ')}
               WHERE id IN (${placeholders(tombstoneIds)})
                 AND user_id = ? AND namespace = ?`,
            )
            .run(
              ...assignmentValues,
              ...tombstoneIds,
              ownerId,
              scopedNamespace,
            );
        }
      }

      const purgeColumns = tableColumns(backup, 'purge_jobs');
      if (
        purgeColumns.has('memory_id') &&
        purgeColumns.has('reason')
      ) {
        const assignments = ['reason = ?'];
        const values: SQLInputValue[] = [
          `purged:${sha256(contentHash)}`,
        ];
        if (purgeColumns.has('last_error')) {
          assignments.push('last_error = NULL');
        }
        backup
          .prepare(
            `UPDATE purge_jobs
             SET ${assignments.join(', ')}
             WHERE memory_id IN (${memoryPlaceholders})`,
          )
          .run(...values, ...uniqueTargetIds);
      }

      const reflectionClaimColumns = tableColumns(
        backup,
        'memory_reflection_claims',
      );
      if (
        reflectionClaimColumns.size > 0 &&
        [
          'user_id',
          'namespace',
          'candidate_id',
          'first_run_id',
          'last_run_id',
        ].some((column) => !reflectionClaimColumns.has(column))
      ) {
        throw new Error(
          '系统受管迁移备份清除已中止：reflection claim 缺少租户引用边界',
        );
      }
      const reflectionClaimConditions: string[] = [];
      const reflectionClaimValues: SQLInputValue[] = [];
      if (candidateIds.length > 0 && reflectionClaimColumns.size > 0) {
        reflectionClaimConditions.push(
          `candidate_id IN (${placeholders(candidateIds)})`,
        );
        reflectionClaimValues.push(...candidateIds);
      }
      if (reflectionRunIds.length > 0 && reflectionClaimColumns.size > 0) {
        reflectionClaimConditions.push(
          `first_run_id IN (${placeholders(reflectionRunIds)})`,
          `last_run_id IN (${placeholders(reflectionRunIds)})`,
        );
        reflectionClaimValues.push(
          ...reflectionRunIds,
          ...reflectionRunIds,
        );
      }
      if (reflectionClaimConditions.length > 0) {
        const ambiguousClaimCount = Number(
          backup.prepare(
            `SELECT COUNT(*) AS count
             FROM memory_reflection_claims
             WHERE (${reflectionClaimConditions.join(' OR ')})
               AND (user_id != ? OR namespace != ?)`,
          ).get(
            ...reflectionClaimValues,
            ownerId,
            scopedNamespace,
          )?.count || 0,
        );
        if (ambiguousClaimCount > 0) {
          throw new Error(
            '系统受管迁移备份清除已中止：reflection claim 租户错配',
          );
        }
        backup.prepare(
          `DELETE FROM memory_reflection_claims
           WHERE user_id = ? AND namespace = ?
             AND (${reflectionClaimConditions.join(' OR ')})`,
        ).run(
          ownerId,
          scopedNamespace,
          ...reflectionClaimValues,
        );
      }
      if (
        candidateIds.length > 0 &&
        candidateEvidenceColumns.has('candidate_id')
      ) {
        if (
          candidateEvidenceColumns.has('user_id') &&
          candidateEvidenceColumns.has('namespace')
        ) {
          const ambiguousEvidenceCount = Number(
            backup.prepare(
              `SELECT COUNT(*) AS count
               FROM memory_candidate_evidence
               WHERE candidate_id IN (${placeholders(candidateIds)})
                 AND (user_id != ? OR namespace != ?)`,
            ).get(
              ...candidateIds,
              ownerId,
              scopedNamespace,
            )?.count || 0,
          );
          if (ambiguousEvidenceCount > 0) {
            throw new Error(
              '系统受管迁移备份清除已中止：candidate evidence 租户错配',
            );
          }
        }
        backup.prepare(
          `DELETE FROM memory_candidate_evidence
           WHERE candidate_id IN (${placeholders(candidateIds)})`,
        ).run(...candidateIds);
      }
      if (candidateIds.length > 0) {
        backup
          .prepare(
            `DELETE FROM memory_candidates
             WHERE id IN (${placeholders(candidateIds)})
               AND user_id = ? AND namespace = ?`,
          )
          .run(
            ...candidateIds,
            ownerId,
            scopedNamespace,
          );
      }
      if (reflectionRunIds.length > 0) {
        if (
          reflectionRunTurnColumns.has('run_id') &&
          reflectionRunTurnColumns.has('turn_id')
        ) {
          const ambiguousRunTurnCount = Number(
            backup.prepare(
              `SELECT COUNT(*) AS count
               FROM memory_reflection_run_turns rt
               LEFT JOIN conversation_turns t ON t.id = rt.turn_id
               WHERE rt.run_id IN (${placeholders(reflectionRunIds)})
                 AND (
                   t.id IS NULL OR t.user_id != ? OR t.namespace != ?
                 )`,
            ).get(
              ...reflectionRunIds,
              ownerId,
              scopedNamespace,
            )?.count || 0,
          );
          if (ambiguousRunTurnCount > 0) {
            throw new Error(
              '系统受管迁移备份清除已中止：reflection run-turn 租户错配',
            );
          }
        }
        backup.prepare(
          `DELETE FROM memory_reflection_runs
           WHERE user_id = ? AND namespace = ?
             AND id IN (${placeholders(reflectionRunIds)})`,
        ).run(
          ownerId,
          scopedNamespace,
          ...reflectionRunIds,
        );
      }
      const checkpointColumns = tableColumns(
        backup,
        'memory_reflection_checkpoints',
      );
      if (
        checkpointColumns.size > 0 &&
        [
          'user_id',
          'namespace',
          'scope_type',
          'scope_key',
        ].some((column) => !checkpointColumns.has(column))
      ) {
        throw new Error(
          '系统受管迁移备份清除已中止：reflection checkpoint 缺少租户作用域',
        );
      }
      if (checkpointColumns.size > 0) {
        const assignments = [
          checkpointColumns.has('last_ingest_seq')
            ? 'last_ingest_seq = 0'
            : '',
          checkpointColumns.has('last_turn_occurred_at')
            ? 'last_turn_occurred_at = NULL'
            : '',
          checkpointColumns.has('last_turn_id')
            ? 'last_turn_id = NULL'
            : '',
          checkpointColumns.has('last_success_at')
            ? 'last_success_at = NULL'
            : '',
          checkpointColumns.has('updated_at')
            ? 'updated_at = ?'
            : '',
        ].filter(Boolean);
        const assignmentValues = checkpointColumns.has('updated_at')
          ? [timestamp]
          : [];
        if (assignments.length > 0) {
          for (const row of reflectionRunRows) {
            const where = [
              'user_id = ?',
              'namespace = ?',
              'scope_type = ?',
              'scope_key = ?',
            ];
            const values: SQLInputValue[] = [
              ownerId,
              scopedNamespace,
              cleanText(row.scope_type),
              cleanText(row.scope_key),
            ];
            if (
              checkpointColumns.has('run_type') &&
              reflectionRunColumns.has('run_type')
            ) {
              where.push('run_type = ?');
              values.push(cleanText(row.run_type));
            }
            if (
              checkpointColumns.has('generation_key') &&
              reflectionRunColumns.has('generation_key')
            ) {
              where.push('generation_key = ?');
              values.push(cleanText(row.generation_key));
            }
            backup.prepare(
              `UPDATE memory_reflection_checkpoints
               SET ${assignments.join(', ')}
               WHERE ${where.join(' AND ')}`,
            ).run(...assignmentValues, ...values);
          }
          if (
            turnIds.length > 0 &&
            checkpointColumns.has('last_turn_id')
          ) {
            backup.prepare(
              `UPDATE memory_reflection_checkpoints
               SET ${assignments.join(', ')}
               WHERE user_id = ? AND namespace = ?
                 AND last_turn_id IN (${placeholders(turnIds)})`,
            ).run(
              ...assignmentValues,
              ownerId,
              scopedNamespace,
              ...turnIds,
            );
          }
        }
      }
      if (
        derivedRows.length > 0 &&
        tableExists(backup, 'derived_consolidations')
      ) {
        const derivedIds = uniqueText(
          derivedRows.map((row) => row.id),
        );
        if (derivedIds.length > 0) {
          backup
            .prepare(
              `DELETE FROM derived_consolidations
               WHERE id IN (${placeholders(derivedIds)})`,
            )
            .run(...derivedIds);
        }
      }
      deleteLayeredPurgeRows(
        backup,
        derivedClosure,
        ownerId,
        scopedNamespace,
      );
      for (const table of [
        'memory_embeddings',
        'memory_ann_index',
        'memory_term_index',
        'memory_dense_lsh',
        'memories_fts',
      ]) {
        const columns = tableColumns(backup, table);
        if (!columns.has('memory_id')) continue;
        backup
          .prepare(
            `DELETE FROM "${table}"
             WHERE memory_id IN (${memoryPlaceholders})`,
          )
          .run(...uniqueTargetIds);
      }
      for (const table of ['memories', 'memory_items']) {
        const columns = tableColumns(backup, table);
        if (!columns.has('id')) continue;
        backup
          .prepare(
            `DELETE FROM "${table}"
             WHERE id IN (${memoryPlaceholders})`,
          )
          .run(...uniqueTargetIds);
      }
      assertProjectionReferencesCleared(
        backup,
        derivedClosure.projectionIds,
        '系统受管迁移备份清除后',
      );
      rebuildSecureFts(backup);
      const foreignKeyFailures =
        backup.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyFailures.length > 0) {
        throw new Error('系统受管迁移备份清除后外键校验失败');
      }
      backup.exec('COMMIT');
    } catch (error) {
      backup.exec('ROLLBACK');
      throw error;
    }

    checkpointTruncate(backup, '系统受管迁移备份');
    if (
      this.countBackupMatches(
        backup,
        'memories',
        'id',
        uniqueTargetIds,
      ) > 0 ||
      this.countBackupMatches(
        backup,
        'memory_items',
        'id',
        uniqueTargetIds,
      ) > 0
    ) {
      throw new Error('系统受管迁移备份仍保留待清除记忆');
    }
    return true;
  }

  private countBackupMatches(
    database: DatabaseSync,
    table: string,
    column: string,
    values: string[],
  ): number {
    if (
      values.length === 0 ||
      !tableColumns(database, table).has(column)
    ) {
      return 0;
    }
    return Number(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM "${table}"
           WHERE "${column}" IN (${placeholders(values)})`,
        )
        .get(...values)?.count || 0,
    );
  }

  private archive(
    memoryId: string,
    userId: string,
    reason: string,
    timestamp: string,
    weight: number,
  ): void {
    this.transitionArchiveState(
      memoryId,
      userId,
      'active',
      'archived',
      reason,
      timestamp,
      'retention_archived',
      { reason, weight: Number(weight.toFixed(6)) },
    );
  }

  private transitionArchiveState(
    memoryId: string,
    userId: string,
    expectedStatus: 'active' | 'archived',
    targetStatus: 'active' | 'archived',
    archiveReason: string | null,
    timestamp: string,
    eventType: 'archived' | 'unarchived' | 'retention_archived',
    payload: Record<string, unknown>,
  ): MemoryGovernanceRecord {
    const id = cleanText(memoryId);
    const ownerId = cleanText(userId);
    const item = this.get(id, ownerId);
    const projection = this.memoryStore.get(id, true, ownerId);
    if (!item || !projection) {
      throw new Error('记忆不存在或不属于当前用户');
    }
    if (
      item.status === targetStatus &&
      projection.status === targetStatus
    ) {
      return item;
    }
    if (
      item.status !== expectedStatus ||
      projection.status !== expectedStatus
    ) {
      throw new Error(
        targetStatus === 'archived'
          ? '只有当前有效记忆可以归档'
          : '只有已归档记忆可以恢复',
      );
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const projectionResult = this.database
        .prepare(
          `UPDATE memories
           SET status = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = ?`,
        )
        .run(
          targetStatus,
          timestamp,
          id,
          ownerId,
          expectedStatus,
        );
      const itemResult = this.database
        .prepare(
          `UPDATE memory_items
           SET status = ?, archived_at = ?,
               archive_reason = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = ?`,
        )
        .run(
          targetStatus,
          targetStatus === 'archived' ? timestamp : null,
          targetStatus === 'archived' ? archiveReason : null,
          timestamp,
          id,
          ownerId,
          expectedStatus,
        );
      if (
        Number(projectionResult.changes) !== 1 ||
        Number(itemResult.changes) !== 1
      ) {
        throw new Error('归档状态已被其他操作修改，请重试');
      }
      this.syncLayeredArchiveState(
        id,
        ownerId,
        projection.namespace,
        projection.source,
        targetStatus,
        timestamp,
      );
      this.recordEvent(
        id,
        ownerId,
        eventType,
        payload,
        timestamp,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(id, ownerId)!;
  }

  private syncLayeredArchiveState(
    memoryId: string,
    userId: string,
    namespace: string,
    source: string,
    targetStatus: 'active' | 'archived',
    timestamp: string,
  ): void {
    if (source === 'hierarchical_summary') {
      if (targetStatus === 'archived') {
        this.database.prepare(
          `UPDATE conversation_memory_summaries
           SET status = 'quarantined', updated_at = ?
           WHERE memory_id = ? AND user_id = ? AND namespace = ?
             AND status = 'active'`,
        ).run(timestamp, memoryId, userId, namespace);
      }
      return;
    }
    if (source !== 'conversation_episode') return;

    if (targetStatus === 'active') {
      this.database.prepare(
        `UPDATE conversation_episodes
         SET status = 'active', updated_at = ?
         WHERE memory_id = ? AND user_id = ? AND namespace = ?
           AND status = 'archived'`,
      ).run(timestamp, memoryId, userId, namespace);
      return;
    }
    const episodeRows = this.database.prepare(
      `SELECT id
       FROM conversation_episodes
       WHERE memory_id = ? AND user_id = ? AND namespace = ?
         AND status = 'active'`,
    ).all(memoryId, userId, namespace) as DatabaseRow[];
    if (episodeRows.length === 0) return;
    const episodeIds = episodeRows.map((row) => cleanText(row.id));
    const episodePlaceholders = episodeIds.map(() => '?').join(', ');
    this.database.prepare(
      `UPDATE conversation_episodes
       SET status = 'archived', updated_at = ?
       WHERE id IN (${episodePlaceholders})`,
    ).run(timestamp, ...episodeIds);

    const summaries = this.database.prepare(
      `SELECT DISTINCT summary.id, summary.memory_id
       FROM conversation_memory_summaries summary
       JOIN conversation_memory_summary_sources source_link
         ON source_link.summary_id = summary.id
       WHERE summary.user_id = ? AND summary.namespace = ?
         AND summary.status = 'active'
         AND source_link.episode_id IN (${episodePlaceholders})`,
    ).all(
      userId,
      namespace,
      ...episodeIds,
    ) as DatabaseRow[];
    if (summaries.length === 0) return;
    const summaryIds = summaries.map((row) => cleanText(row.id));
    const summaryMemoryIds = summaries.map((row) => cleanText(row.memory_id));
    this.database.prepare(
      `UPDATE conversation_memory_summaries
       SET status = 'quarantined', updated_at = ?
       WHERE id IN (${summaryIds.map(() => '?').join(', ')})`,
    ).run(timestamp, ...summaryIds);
    this.database.prepare(
      `UPDATE memories
       SET status = 'archived', updated_at = ?
       WHERE user_id = ? AND namespace = ?
         AND id IN (${summaryMemoryIds.map(() => '?').join(', ')})
         AND status = 'active'`,
    ).run(timestamp, userId, namespace, ...summaryMemoryIds);
    this.database.prepare(
      `UPDATE memory_items
       SET status = 'archived', archived_at = ?,
           archive_reason = 'episode_source_archived', updated_at = ?
       WHERE user_id = ? AND namespace = ?
         AND id IN (${summaryMemoryIds.map(() => '?').join(', ')})
         AND status = 'active'`,
    ).run(timestamp, timestamp, userId, namespace, ...summaryMemoryIds);
  }

  private redactExpiredEvidence(
    userId: string,
    namespace: string | undefined,
    policies: RetentionPolicy[],
    timestamp: string,
  ): number {
    const scopedPolicies = policies.filter(
      (policy) =>
        !namespace || policy.namespace === cleanText(namespace),
    );
    const policyDays = scopedPolicies
      .map((policy) => policy.evidenceTtlDays)
      .filter((days): days is number => days !== null);
    // 语义优先级：显式配了天数 → 取最小天数；该 scope 有策略但全部为 null
    // → 明确不抹除；完全没有策略 → 用默认值（现为不抹除）。
    const ttlDays =
      policyDays.length > 0
        ? Math.min(...policyDays)
        : scopedPolicies.length > 0
          ? null
          : DEFAULT_EVIDENCE_TTL_DAYS;
    if (ttlDays === null) return 0;
    const cutoff = new Date(
      Date.parse(timestamp) - ttlDays * 86_400_000,
    ).toISOString();
    const values: SQLInputValue[] = [userId, cutoff];
    const namespaceFilter = namespace
      ? 'AND t.namespace = ?'
      : '';
    if (namespace) values.push(cleanText(namespace));
    const rows = this.database
      .prepare(
        `SELECT DISTINCT t.id
         FROM conversation_turns t
         WHERE t.user_id = ?
           AND t.occurred_at < ?
           ${namespaceFilter}
           AND t.content != '[purged]'
           AND NOT EXISTS (
             SELECT 1
             FROM memory_evidence e
             JOIN memory_versions v
               ON v.id = e.memory_version_id
             JOIN memory_items i
               ON i.id = v.memory_item_id
             WHERE e.turn_id = t.id
               AND i.pinned = 1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM memory_candidate_evidence ce
             JOIN memory_candidates c ON c.id = ce.candidate_id
             JOIN memory_items i ON i.id = c.resolved_memory_item_id
             WHERE ce.turn_id = t.id
               AND i.pinned = 1
           )`,
      )
      .all(...values) as DatabaseRow[];
    if (rows.length === 0) return 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const turnId = cleanText(row.id);
        this.database
          .prepare(
            `UPDATE conversation_turns
             SET content = '[retention-redacted]',
                 content_hash = ?,
                 metadata_json = ?
             WHERE id = ?`,
          )
          .run(
            sha256(`retention:${turnId}:${cutoff}`),
            JSON.stringify({
              retentionRedactedAt: timestamp,
            }),
            turnId,
          );
        this.database
          .prepare(
            `UPDATE memory_evidence
             SET excerpt = NULL
             WHERE turn_id = ?`,
          )
          .run(turnId);
        this.database
          .prepare(
            `UPDATE memory_candidate_evidence
             SET excerpt = NULL
             WHERE turn_id = ?`,
          )
          .run(turnId);
        this.database
          .prepare(
            `UPDATE memory_candidates
             SET source_excerpt = NULL,
                 updated_at = CASE
                   WHEN updated_at > ? THEN updated_at
                   ELSE ?
                 END
             WHERE turn_id = ?`,
          )
          .run(timestamp, timestamp, turnId);
        this.database
          .prepare(
            `UPDATE memory_pattern_observations
             SET excerpt = '[retention-redacted]',
                 observation_state = CASE
                   WHEN observation_state IN ('supporting', 'contradicting')
                     THEN 'superseded'
                   ELSE observation_state
                 END,
                 updated_at = CASE
                   WHEN updated_at > ? THEN updated_at
                   ELSE ?
                 END
             WHERE turn_id = ?`,
          )
          .run(timestamp, timestamp, turnId);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  private recordEvent(
    memoryId: string,
    userId: string,
    eventType: string,
    payload: Record<string, unknown>,
    timestamp: string,
  ): void {
    const ownerId = cleanText(userId);
    const memoryScope = this.database
      .prepare(
        `SELECT namespace
         FROM memory_items
         WHERE id = ? AND user_id = ?`,
      )
      .get(
        cleanText(memoryId),
        ownerId,
      ) as DatabaseRow | undefined;
    if (!memoryScope) {
      throw new Error(
        '治理事件对应的记忆不存在或不属于当前用户',
      );
    }
    const namespace = cleanText(memoryScope.namespace);
    const eventId = randomUUID();
    this.database
      .prepare(
        `INSERT INTO memory_events (
           id, memory_item_id, user_id, event_type, payload_json,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        memoryId,
        ownerId,
        eventType,
        JSON.stringify(payload),
        timestamp,
      );
    this.database
      .prepare(
        `INSERT INTO outbox_events (
           id, aggregate_type, aggregate_id, event_type, payload_json,
           available_at, created_at, user_id, namespace
         ) VALUES (?, 'memory_event', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(
           aggregate_type, aggregate_id, event_type
         ) DO NOTHING`,
      )
      .run(
        `memory-event:${eventId}`,
        eventId,
        eventType,
        JSON.stringify({ memoryId, ...payload }),
        timestamp,
        timestamp,
        ownerId,
        namespace,
      );
  }

  private insertAudit(
    action: string,
    memoryId: string | null,
    userId: string,
    detail: Record<string, unknown>,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO audit_log (
           id, action, memory_id, user_id, detail_json, created_at
         )
         SELECT COALESCE(MAX(id), 0) + 1, ?, ?, ?, ?, ?
         FROM audit_log
         WHERE user_id = ?`,
      )
      .run(
        action,
        memoryId,
        userId,
        JSON.stringify(detail),
        timestamp,
        userId,
      );
  }

  private sanitizeAudit(
    memoryId: string,
    userId: string,
    auditHash: string,
  ): void {
    const rows = this.database
      .prepare(
        `SELECT row_id, action
         FROM audit_log
         WHERE user_id = ?
           AND (
             memory_id = ?
             OR detail_json LIKE ?
           )`,
      )
      .all(userId, memoryId, `%${memoryId}%`) as DatabaseRow[];
    for (const row of rows) {
      this.database
        .prepare(
          `UPDATE audit_log
           SET memory_id = NULL, detail_json = ?
           WHERE row_id = ?`,
        )
        .run(
          JSON.stringify({
            purgedHash: auditHash,
            actionHash: sha256(cleanText(row.action)),
          }),
          Number(row.row_id),
        );
    }
  }

  private sanitizePurgeRecord(
    job: PurgeJobRecord,
    timestamp: string,
    auditHash: string,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE purge_jobs
         SET reason = ?, content_hash = ?, last_error = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'running'
           AND lease_owner = ? AND attempts = ?`,
      )
      .run(
        sanitizedPurgeReason(job.reason),
        auditHash,
        timestamp,
        job.id,
        job.leaseOwner,
        job.attempts,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('物理清除内部租约已失效，拒绝提交清除事务');
    }
  }

  private checkpointPurgedWal(): void {
    checkpointTruncate(this.database, '物理清除后的主数据库');
  }

  private completePurgeRecord(
    job: PurgeJobRecord,
    timestamp: string,
    auditHash = job.contentHash,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE purge_jobs
         SET status = 'completed',
             reason = ?,
             content_hash = ?,
             lease_until = NULL,
             lease_owner = NULL,
             last_error = NULL,
             updated_at = ?,
             completed_at = ?
         WHERE id = ? AND status = 'running'
           AND lease_owner = ? AND attempts = ?`,
      )
      .run(
        sanitizedPurgeReason(job.reason),
        auditHash,
        timestamp,
        timestamp,
        job.id,
        job.leaseOwner,
        job.attempts,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('物理清除内部租约已失效，拒绝标记完成');
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

export {
  DEFAULT_EVIDENCE_TTL_DAYS,
  DEFAULT_HALF_LIFE_DAYS,
};
