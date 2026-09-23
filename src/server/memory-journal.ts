import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  MemoryRecord,
  MemorySensitivity,
  PredicateCardinality,
  SourceAuthority,
} from './types.js';
import { tombstoneIdentityFields } from './tombstone-policy.js';

type DatabaseRow = Record<string, unknown>;

export interface MemoryVersionRecord {
  id: string;
  memoryItemId: string;
  version: number;
  content: string;
  createdBy: string;
  createdAt: string;
}

export interface CanonicalMemoryMetadata {
  predicateKey?: string;
  normalizedValueHash?: string;
  normalizedValue?: string;
  predicateCardinality?: PredicateCardinality;
}

export interface AppendVersionOptions {
  canonical?: CanonicalMemoryMetadata;
  expectedRevision?: number;
  closePreviousVersion?: boolean;
}

export interface ActiveMemoryTombstone {
  id: string;
  memoryItemId: string;
  deletionGeneration: number;
  createdAt: string;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

export class MemoryJournal {
  constructor(private readonly database: DatabaseSync) {}

  recordCreate(
    memory: MemoryRecord,
    createdBy: string,
    eventType = 'created',
    stableKey = `explicit:${memory.id}`,
    canonical: CanonicalMemoryMetadata = {},
  ): string {
    const existing = this.database
      .prepare('SELECT id FROM memory_items WHERE id = ?')
      .get(memory.id);
    if (existing) {
      return asText(
        this.database
          .prepare(
            `SELECT current_version_id
             FROM memory_items
             WHERE id = ?`,
          )
          .get(memory.id)?.current_version_id,
      );
    }

    const versionId = randomUUID();
    this.database
      .prepare(
        `INSERT INTO memory_items (
           id, user_id, namespace, kind, stable_key, current_version_id,
           status, revision, created_at, updated_at, predicate_key,
           normalized_value_hash, normalized_value,
           predicate_cardinality, observation_count, scope_type,
           scope_key, sensitivity, source_authority
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
         )`,
      )
      .run(
        memory.id,
        memory.userId,
        memory.namespace,
        memory.kind,
        stableKey,
        versionId,
        memory.status,
        memory.createdAt,
        memory.updatedAt,
        canonical.predicateKey || stableKey,
        canonical.normalizedValueHash || null,
        canonical.normalizedValue || null,
        canonical.predicateCardinality || 'single',
        memory.scopeType,
        memory.scopeKey,
        memory.sensitivity,
        memory.sourceAuthority,
      );
    this.insertVersion(
      versionId,
      memory,
      1,
      createdBy,
      memory.createdAt,
      canonical,
    );
    this.recordEvent(memory, eventType, {
      versionId,
      version: 1,
    });
    return versionId;
  }

  appendVersion(
    memory: MemoryRecord,
    createdBy: string,
    eventType: string,
    payload: Record<string, unknown> = {},
    options: AppendVersionOptions = {},
  ): string {
    const item = this.database
      .prepare(
        `SELECT revision, current_version_id, predicate_key,
                normalized_value_hash, normalized_value,
                predicate_cardinality
         FROM memory_items
         WHERE id = ? AND user_id = ?`,
      )
      .get(memory.id, memory.userId) as DatabaseRow | undefined;
    if (!item) {
      return this.recordCreate(
        memory,
        createdBy,
        eventType,
        undefined,
        options.canonical,
      );
    }

    const version = Number(item.revision) + 1;
    const expectedRevision =
      options.expectedRevision ?? Number(item.revision);
    const requestedCanonical = options.canonical || {};
    const canonical: CanonicalMemoryMetadata = {
      predicateKey:
        requestedCanonical.predicateKey ||
        asText(item.predicate_key) ||
        undefined,
      normalizedValueHash:
        requestedCanonical.normalizedValueHash ||
        asText(item.normalized_value_hash) ||
        undefined,
      normalizedValue:
        requestedCanonical.normalizedValue ||
        asText(item.normalized_value) ||
        undefined,
      predicateCardinality:
        requestedCanonical.predicateCardinality ||
        asText(item.predicate_cardinality) as PredicateCardinality,
    };
    const versionId = randomUUID();
    this.insertVersion(
      versionId,
      memory,
      version,
      createdBy,
      memory.updatedAt,
      canonical,
    );
    if (options.closePreviousVersion) {
      this.database
        .prepare(
          `UPDATE memory_versions
           SET superseded_at = COALESCE(superseded_at, ?),
               valid_to = COALESCE(valid_to, ?)
           WHERE id = ?`,
        )
        .run(
          memory.updatedAt,
          memory.validFrom || memory.updatedAt,
          asText(item.current_version_id),
        );
    }
    const result = this.database
      .prepare(
        `UPDATE memory_items
         SET namespace = ?, kind = ?, current_version_id = ?,
             status = ?, revision = ?, updated_at = ?,
             scope_type = ?, scope_key = ?, sensitivity = ?,
             source_authority = ?,
             predicate_key = COALESCE(?, predicate_key),
             normalized_value_hash = COALESCE(
               ?, normalized_value_hash
             ),
             normalized_value = COALESCE(?, normalized_value),
             predicate_cardinality = COALESCE(
               ?, predicate_cardinality
             ),
             observation_count = observation_count + ?
         WHERE id = ? AND user_id = ? AND revision = ?`,
      )
      .run(
        memory.namespace,
        memory.kind,
        versionId,
        memory.status,
        version,
        memory.updatedAt,
        memory.scopeType,
        memory.scopeKey,
        memory.sensitivity,
        memory.sourceAuthority,
        canonical.predicateKey || null,
        canonical.normalizedValueHash || null,
        canonical.normalizedValue || null,
        canonical.predicateCardinality || null,
        eventType === 'reinforced' ? 1 : 0,
        memory.id,
        memory.userId,
        expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('记忆版本已变化，请重新解析候选');
    }
    this.recordEvent(memory, eventType, {
      ...payload,
      versionId,
      version,
    });
    return versionId;
  }

  recordStatus(
    memory: MemoryRecord,
    eventType: string,
    payload: Record<string, unknown> = {},
  ): void {
    const result = this.database
      .prepare(
        `UPDATE memory_items
         SET status = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        memory.status,
        memory.updatedAt,
        memory.id,
        memory.userId,
      );
    if (Number(result.changes) !== 1) {
      this.recordCreate(memory, 'projection-repair', eventType);
      return;
    }
    this.recordEvent(memory, eventType, payload);
  }

  recordEvidence(
    memoryVersionId: string,
    input: {
      turnId?: string;
      evidenceType: string;
      excerpt?: string;
      sourceRef?: string;
      sensitivity?: MemorySensitivity;
      sourceAuthority?: SourceAuthority;
      createdAt: string;
    },
  ): string {
    const versionId = memoryVersionId.trim();
    const turnId = input.turnId?.trim() || null;
    if (!versionId) {
      throw new Error('记忆证据目标版本不能为空');
    }
    if (turnId) {
      const validBinding = this.database
        .prepare(
          `SELECT 1
           FROM memory_versions v
           JOIN memory_items i ON i.id = v.memory_item_id
           JOIN memories m ON m.id = i.id
           JOIN conversation_turns t ON t.id = ?
           JOIN conversation_sessions s ON s.id = t.session_id
           WHERE v.id = ?
             AND m.user_id = i.user_id
             AND m.namespace = i.namespace
             AND t.user_id = i.user_id
             AND t.namespace = i.namespace
             AND s.user_id = i.user_id
             AND s.namespace = i.namespace
             AND (
               (v.scope_type = 'personal' AND v.scope_key = 'self')
               OR (v.scope_type = 'role' AND s.persona_id = v.scope_key)
               OR (v.scope_type = 'project' AND s.project_id = v.scope_key)
               OR (v.scope_type = 'session' AND s.external_id = v.scope_key)
             )`,
        )
        .get(turnId, versionId);
      if (!validBinding) {
        throw new Error('记忆证据 owner/namespace/scope 不一致');
      }
    } else {
      const versionOwner = this.database
        .prepare(
          `SELECT 1
           FROM memory_versions v
           JOIN memory_items i ON i.id = v.memory_item_id
           JOIN memories m ON m.id = i.id
           WHERE v.id = ?
             AND m.user_id = i.user_id
             AND m.namespace = i.namespace`,
        )
        .get(versionId);
      if (!versionOwner) {
        throw new Error('记忆证据目标版本不存在或所有权无效');
      }
    }
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO memory_evidence (
           id, memory_version_id, turn_id, evidence_type, excerpt,
           source_ref, sensitivity, source_authority, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        versionId,
        turnId,
        input.evidenceType,
        input.excerpt || null,
        input.sourceRef || null,
        input.sensitivity || 'normal',
        input.sourceAuthority || 'legacy_unknown',
        input.createdAt,
      );
    return id;
  }

  recordObservation(
    memory: MemoryRecord,
    input: {
      expectedRevision: number;
      turnId?: string;
      excerpt?: string;
      sourceRef?: string;
      sensitivity: MemorySensitivity;
      sourceAuthority: SourceAuthority;
      createdAt: string;
    },
  ): string {
    const item = this.database
      .prepare(
        `SELECT current_version_id
         FROM memory_items
         WHERE id = ? AND user_id = ? AND revision = ?`,
      )
      .get(
        memory.id,
        memory.userId,
        input.expectedRevision,
      ) as DatabaseRow | undefined;
    if (!item) {
      throw new Error('记忆版本已变化，请重新解析候选');
    }
    const versionId = asText(item.current_version_id);
    const result = this.database
      .prepare(
        `UPDATE memory_items
         SET observation_count = observation_count + 1,
             updated_at = ?
         WHERE id = ? AND user_id = ? AND revision = ?`,
      )
      .run(
        input.createdAt,
        memory.id,
        memory.userId,
        input.expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('记忆版本已变化，请重新解析候选');
    }
    this.recordEvidence(versionId, {
      turnId: input.turnId,
      evidenceType: 'equivalent_observation',
      excerpt: input.excerpt,
      sourceRef: input.sourceRef,
      sensitivity: input.sensitivity,
      sourceAuthority: input.sourceAuthority,
      createdAt: input.createdAt,
    });
    this.recordEvent(
      { ...memory, updatedAt: input.createdAt },
      'observed',
      { versionId, observation: 'equivalent' },
    );
    return versionId;
  }

  recordEdge(
    fromMemoryItemId: string,
    toMemoryItemId: string,
    relationType: string,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO memory_edges (
           id, from_memory_item_id, to_memory_item_id, relation_type,
           created_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(
           from_memory_item_id,
           to_memory_item_id,
           relation_type
         ) DO NOTHING`,
      )
      .run(
        randomUUID(),
        fromMemoryItemId,
        toMemoryItemId,
        relationType,
        createdAt,
      );
  }

  recordTombstone(memory: MemoryRecord, reason: string): string {
    const item = this.database
      .prepare(
        `SELECT kind, stable_key, predicate_key, normalized_value,
                scope_type, scope_key
         FROM memory_items
         WHERE id = ? AND user_id = ?`,
      )
      .get(memory.id, memory.userId) as DatabaseRow | undefined;
    const stableKey = item ? asText(item.stable_key) : null;
    const identity = tombstoneIdentityFields({
      kind:
        (item ? asText(item.kind) : memory.kind) as MemoryRecord['kind'],
      content: memory.content,
      stableKey,
      normalizedKey: item ? asText(item.predicate_key) : null,
      normalizedValue: item ? asText(item.normalized_value) : null,
      scopeType: memory.scopeType,
      scopeKey: memory.scopeKey,
    });
    const existing = this.database
      .prepare(
        `SELECT id
         FROM memory_tombstones
         WHERE user_id = ? AND memory_item_id = ?
           AND restored_at IS NULL
         ORDER BY deletion_generation DESC, created_at DESC
         LIMIT 1`,
      )
      .get(
        memory.userId,
        memory.id,
      );
    if (existing) return asText(existing.id);

    const generation = Number(
      this.database
        .prepare(
          `SELECT COALESCE(MAX(deletion_generation), 0) + 1 AS generation
           FROM memory_tombstones
           WHERE user_id = ? AND memory_item_id = ?`,
        )
        .get(memory.userId, memory.id)?.generation || 1,
    );
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO memory_tombstones (
           id, user_id, namespace, stable_key, content_hash, reason,
           created_at, scope_type, scope_key, memory_item_id,
           deletion_generation, kind, normalized_key, normalized_value,
           semantic_fingerprint
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        memory.userId,
        memory.namespace,
        stableKey,
        identity.contentHash,
        reason,
        memory.updatedAt,
        memory.scopeType,
        memory.scopeKey,
        memory.id,
        generation,
        identity.kind,
        identity.normalizedKey,
        identity.normalizedValue,
        identity.semanticFingerprint,
      );
    return id;
  }

  activeTombstone(
    memoryItemId: string,
    userId: string,
  ): ActiveMemoryTombstone | null {
    const row = this.database
      .prepare(
        `SELECT id, memory_item_id, deletion_generation, created_at
         FROM memory_tombstones
         WHERE user_id = ? AND memory_item_id = ?
           AND restored_at IS NULL
         ORDER BY deletion_generation DESC, created_at DESC
         LIMIT 1`,
      )
      .get(userId, memoryItemId) as DatabaseRow | undefined;
    return row
      ? {
          id: asText(row.id),
          memoryItemId: asText(row.memory_item_id),
          deletionGeneration: Number(row.deletion_generation),
          createdAt: asText(row.created_at),
        }
      : null;
  }

  restoreTombstone(
    tombstone: ActiveMemoryTombstone,
    restoredAt: string,
  ): number {
    const result = this.database
      .prepare(
        `UPDATE memory_tombstones
         SET restored_at = ?
         WHERE id = ? AND memory_item_id = ?
           AND deletion_generation = ?
           AND restored_at IS NULL
        `,
      )
      .run(
        restoredAt,
        tombstone.id,
        tombstone.memoryItemId,
        tombstone.deletionGeneration,
      );
    return Number(result.changes);
  }

  resetUser(userId: string): void {
    this.database
      .prepare('DELETE FROM memory_events WHERE user_id = ?')
      .run(userId);
    this.database
      .prepare('DELETE FROM memory_items WHERE user_id = ?')
      .run(userId);
    this.database
      .prepare('DELETE FROM memory_tombstones WHERE user_id = ?')
      .run(userId);
  }

  history(memoryItemId: string): MemoryVersionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT *
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version ASC`,
      )
      .all(memoryItemId) as DatabaseRow[];
    return rows.map((row) => ({
      id: asText(row.id),
      memoryItemId: asText(row.memory_item_id),
      version: Number(row.version),
      content: asText(row.content),
      createdBy: asText(row.created_by),
      createdAt: asText(row.created_at),
    }));
  }

  private insertVersion(
    versionId: string,
    memory: MemoryRecord,
    version: number,
    createdBy: string,
    createdAt: string,
    canonical: CanonicalMemoryMetadata = {},
  ): void {
    this.database
      .prepare(
        `INSERT INTO memory_versions (
           id, memory_item_id, version, title, content, summary,
           tags_json, importance, confidence, source, source_ref,
           occurred_at, valid_from, valid_to, created_by, created_at,
           predicate_key, normalized_value_hash, normalized_value,
           predicate_cardinality, namespace, kind, scope_type, scope_key,
           sensitivity, source_authority, negated
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        versionId,
        memory.id,
        version,
        memory.title,
        memory.content,
        memory.summary,
        JSON.stringify(memory.tags),
        memory.importance,
        memory.confidence,
        memory.source,
        memory.sourceRef,
        memory.occurredAt,
        memory.validFrom,
        memory.validTo,
        createdBy,
        createdAt,
        canonical.predicateKey || null,
        canonical.normalizedValueHash || null,
        canonical.normalizedValue || null,
        canonical.predicateCardinality || null,
        memory.namespace,
        memory.kind,
        memory.scopeType,
        memory.scopeKey,
        memory.sensitivity,
        memory.sourceAuthority,
        memory.negated ? 1 : 0,
      );
  }

  private recordEvent(
    memory: MemoryRecord,
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
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
        memory.id,
        memory.userId,
        eventType,
        JSON.stringify(payload),
        memory.updatedAt,
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
        JSON.stringify({ memoryId: memory.id, ...payload }),
        memory.updatedAt,
        memory.updatedAt,
        memory.userId,
        memory.namespace,
      );
  }
}
