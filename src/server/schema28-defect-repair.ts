import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HybridRetrievalIndex } from './hybrid-retrieval.js';
import { LifecycleStore } from './lifecycle-store.js';
import {
  conditionQualifiersFromText,
  namedRoleScopeNamesFromText,
} from './memory-extractor.js';
import { MemoryStore } from './memory-store.js';

type DatabaseRow = Record<string, unknown>;

export type Schema28RepairAction =
  | 'migrate_role'
  | 'quarantine_role'
  | 'quarantine_and_reextract_condition';

export interface Schema28RepairItem {
  memoryId: string;
  userId: string;
  namespace: string;
  action: Schema28RepairAction;
  reason: string;
  targetPersonaId: string | null;
  roleNames: string[];
  missingQualifiers: string[];
  reextractTurnIds: string[];
}

export interface Schema28RepairReport {
  applied: boolean;
  scanned: number;
  planned: number;
  roleCandidates: number;
  conditionCandidates: number;
  migratedRoleMemories: number;
  quarantinedMemories: number;
  reextractJobsQueued: number;
  consolidationsInvalidated: number;
  indexesInvalidated: number;
  relationsInvalidated: number;
  items: Schema28RepairItem[];
}

export interface Schema28RepairOptions {
  apply?: boolean;
  userId?: string;
  namespace?: string;
  limit?: number;
}

interface EvidenceIdentity {
  turnId: string;
  excerpt: string;
  turnContent: string;
  sessionId: string;
  sessionExternalId: string;
  personaId: string | null;
  projectId: string | null;
  identityStatus: string;
}

interface RepairCandidate {
  row: DatabaseRow;
  evidence: EvidenceIdentity[];
  plan: Schema28RepairItem;
}

function cleanText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim();
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = cleanText(value);
  return text || null;
}

function normalizeRoleAlias(value: unknown): string {
  return cleanText(value)
    .toLocaleLowerCase('zh-CN')
    .replace(/(?:这个|该|此)?角色$/u, '')
    .replace(/\s+/gu, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))].sort();
}

function stableRepairJobId(turnId: string): string {
  return `schema28-condition-reextract-v17:${
    createHash('sha256').update(turnId).digest('hex')
  }`;
}

export class Schema28LongMemoryDefectRepair {
  private readonly retrievalIndex: HybridRetrievalIndex;

  constructor(
    private readonly database: DatabaseSync,
    private readonly memoryStore: MemoryStore,
    private readonly lifecycleStore: LifecycleStore,
  ) {
    this.retrievalIndex = new HybridRetrievalIndex(database);
  }

  run(options: Schema28RepairOptions = {}): Schema28RepairReport {
    const candidates = this.scan(options);
    const report: Schema28RepairReport = {
      applied: options.apply === true,
      scanned: this.scannedCount(options),
      planned: candidates.length,
      roleCandidates: candidates.filter(
        ({ plan }) => plan.roleNames.length > 0,
      ).length,
      conditionCandidates: candidates.filter(
        ({ plan }) => plan.missingQualifiers.length > 0,
      ).length,
      migratedRoleMemories: 0,
      quarantinedMemories: 0,
      reextractJobsQueued: 0,
      consolidationsInvalidated: 0,
      indexesInvalidated: 0,
      relationsInvalidated: 0,
      items: candidates.map(({ plan }) => plan),
    };
    if (!options.apply) return report;

    for (const candidate of candidates) {
      const { plan } = candidate;
      if (plan.action === 'quarantine_and_reextract_condition') {
        report.reextractJobsQueued += this.enqueueReextraction(
          candidate,
        );
      }

      const current = this.memoryStore.get(
        plan.memoryId,
        true,
        plan.userId,
        plan.namespace,
      );
      if (!current || current.status !== 'active') continue;

      if (plan.action === 'migrate_role' && plan.targetPersonaId) {
        this.memoryStore.update(
          plan.memoryId,
          {
            scopeType: 'role',
            scopeKey: plan.targetPersonaId,
            createdBy: 'schema28-long-memory-defect-repair',
            idempotencyKey:
              `schema28-role-scope:${plan.memoryId}:${plan.targetPersonaId}`,
            closePreviousVersion: true,
          },
          plan.userId,
        );
        const invalidated = this.invalidateArtifacts(
          plan.memoryId,
          plan.userId,
          true,
        );
        report.migratedRoleMemories += 1;
        report.consolidationsInvalidated +=
          invalidated.consolidations;
        report.indexesInvalidated += invalidated.indexes;
        report.relationsInvalidated += invalidated.relations;
      } else {
        this.memoryStore.update(
          plan.memoryId,
          {
            status: 'archived',
            createdBy: 'schema28-long-memory-defect-repair',
            idempotencyKey:
              `schema28-defect-quarantine:${plan.memoryId}`,
            closePreviousVersion: true,
          },
          plan.userId,
        );
        this.database.prepare(
          `UPDATE memory_items
           SET archived_at = COALESCE(archived_at, ?),
               archive_reason = 'schema28_defect_quarantine'
           WHERE id = ? AND user_id = ? AND status = 'archived'`,
        ).run(
          new Date().toISOString(),
          plan.memoryId,
          plan.userId,
        );
        const invalidated = this.invalidateArtifacts(
          plan.memoryId,
          plan.userId,
          false,
        );
        report.quarantinedMemories += 1;
        report.consolidationsInvalidated +=
          invalidated.consolidations;
        report.indexesInvalidated += invalidated.indexes;
        report.relationsInvalidated += invalidated.relations;
      }
      this.recordRepairAudit(plan);
    }
    return report;
  }

  private scannedCount(options: Schema28RepairOptions): number {
    const where = [
      "i.status = 'active'",
      "m.status = 'active'",
      "m.source != 'consolidation'",
    ];
    const values: string[] = [];
    if (cleanText(options.userId)) {
      where.push('i.user_id = ?');
      values.push(cleanText(options.userId));
    }
    if (cleanText(options.namespace)) {
      where.push('i.namespace = ?');
      values.push(cleanText(options.namespace));
    }
    return Number(
      this.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_items i
         JOIN memories m ON m.id = i.id
         WHERE ${where.join(' AND ')}`,
      ).get(...values)?.count || 0,
    );
  }

  private scan(options: Schema28RepairOptions): RepairCandidate[] {
    const where = [
      "i.status = 'active'",
      "m.status = 'active'",
      "m.source != 'consolidation'",
    ];
    const values: Array<string | number> = [];
    if (cleanText(options.userId)) {
      where.push('i.user_id = ?');
      values.push(cleanText(options.userId));
    }
    if (cleanText(options.namespace)) {
      where.push('i.namespace = ?');
      values.push(cleanText(options.namespace));
    }
    const limit = Math.max(1, Math.min(options.limit || 10_000, 100_000));
    values.push(limit);
    const rows = this.database.prepare(
      `SELECT i.id, i.user_id, i.namespace, i.scope_type, i.scope_key,
              i.predicate_key, i.normalized_value, i.current_version_id,
              m.content, m.source,
              COALESCE(v.content, '') AS version_content
       FROM memory_items i
       JOIN memories m ON m.id = i.id
       LEFT JOIN memory_versions v ON v.id = i.current_version_id
       WHERE ${where.join(' AND ')}
       ORDER BY i.updated_at ASC, i.id ASC
       LIMIT ?`,
    ).all(...values) as DatabaseRow[];

    const result: RepairCandidate[] = [];
    for (const row of rows) {
      const evidence = this.evidenceForMemory(cleanText(row.id));
      const evidenceText = evidence.map((entry) => [
        entry.excerpt,
        entry.turnContent,
      ].join('\n')).join('\n');
      const roleNames = unique(namedRoleScopeNamesFromText([
        cleanText(row.content),
        cleanText(row.version_content),
        evidenceText,
      ].join('\n')));
      const roleDefect =
        roleNames.length > 0 &&
        cleanText(row.scope_type) === 'personal' &&
        cleanText(row.scope_key) === 'self';

      const evidenceQualifiers = unique(
        evidence.flatMap((entry) =>
          conditionQualifiersFromText([
            entry.excerpt,
            entry.turnContent,
          ].join('\n')),
        ),
      );
      const storedQualifiers = new Set(conditionQualifiersFromText([
        cleanText(row.content),
        cleanText(row.version_content),
        cleanText(row.predicate_key),
        cleanText(row.normalized_value),
      ].join('\n')));
      const missingQualifiers = evidenceQualifiers.filter(
        (qualifier) => !storedQualifiers.has(qualifier),
      );
      if (!roleDefect && missingQualifiers.length === 0) continue;

      const roleResolution = roleDefect
        ? this.resolveRolePersona(
            cleanText(row.user_id),
            roleNames,
            evidence,
          )
        : { personaId: null, reason: '' };
      const reextractEvidence = evidence.filter((entry) => {
        const qualifiers = conditionQualifiersFromText([
          entry.excerpt,
          entry.turnContent,
        ].join('\n'));
        return (
          entry.turnId &&
          entry.sessionId &&
          entry.identityStatus === 'complete' &&
          missingQualifiers.some((qualifier) =>
            qualifiers.includes(qualifier),
          )
        );
      });

      let action: Schema28RepairAction;
      let reason: string;
      if (roleDefect && !roleResolution.personaId) {
        action = 'quarantine_role';
        reason = roleResolution.reason;
      } else if (missingQualifiers.length > 0) {
        action = 'quarantine_and_reextract_condition';
        reason = reextractEvidence.length > 0
          ? 'condition_coverage_missing_reextract_queued'
          : 'condition_coverage_missing_trusted_turn_unavailable';
      } else {
        action = 'migrate_role';
        reason = 'trusted_role_mapping_unique';
      }
      result.push({
        row,
        evidence,
        plan: {
          memoryId: cleanText(row.id),
          userId: cleanText(row.user_id),
          namespace: cleanText(row.namespace),
          action,
          reason,
          targetPersonaId: roleResolution.personaId,
          roleNames,
          missingQualifiers,
          reextractTurnIds: unique(
            reextractEvidence.map((entry) => entry.turnId),
          ),
        },
      });
    }
    return result;
  }

  private evidenceForMemory(memoryId: string): EvidenceIdentity[] {
    const rows = this.database.prepare(
      `SELECT e.turn_id, e.excerpt,
              turn.content AS turn_content,
              session.id AS session_id,
              session.external_id AS session_external_id,
              session.persona_id, session.project_id,
              session.identity_status
       FROM memory_versions version
       JOIN memory_evidence e ON e.memory_version_id = version.id
       LEFT JOIN conversation_turns turn ON turn.id = e.turn_id
       LEFT JOIN conversation_sessions session
         ON session.id = turn.session_id
        AND session.user_id = turn.user_id
        AND session.namespace = turn.namespace
       WHERE version.memory_item_id = ?
       ORDER BY e.created_at ASC, e.id ASC`,
    ).all(memoryId) as DatabaseRow[];
    return rows.map((row) => ({
      turnId: cleanText(row.turn_id),
      excerpt: cleanText(row.excerpt),
      turnContent: cleanText(row.turn_content),
      sessionId: cleanText(row.session_id),
      sessionExternalId: cleanText(row.session_external_id),
      personaId: nullableText(row.persona_id),
      projectId: nullableText(row.project_id),
      identityStatus: cleanText(row.identity_status),
    }));
  }

  private resolveRolePersona(
    userId: string,
    roleNames: string[],
    evidence: EvidenceIdentity[],
  ): { personaId: string | null; reason: string } {
    const evidencePersonas = unique(
      evidence
        .filter((entry) => entry.identityStatus === 'complete')
        .flatMap((entry) => entry.personaId ? [entry.personaId] : []),
    );
    if (evidencePersonas.length !== 1) {
      return {
        personaId: null,
        reason: evidencePersonas.length === 0
          ? 'trusted_evidence_persona_missing'
          : 'trusted_evidence_persona_ambiguous',
      };
    }
    const bindings = this.database.prepare(
      `SELECT persona_id, display_name
       FROM client_persona_bindings
       WHERE principal_id = ? AND status = 'active'
       ORDER BY updated_at DESC, id ASC`,
    ).all(userId) as DatabaseRow[];
    const aliases = new Map<string, Set<string>>();
    for (const binding of bindings) {
      const personaId = cleanText(binding.persona_id);
      for (const alias of [personaId, cleanText(binding.display_name)]) {
        const normalized = normalizeRoleAlias(alias);
        if (!normalized) continue;
        const personaIds = aliases.get(normalized) || new Set<string>();
        personaIds.add(personaId);
        aliases.set(normalized, personaIds);
      }
    }
    const mappedPersonas = new Set<string>();
    for (const roleName of roleNames) {
      const matches = aliases.get(normalizeRoleAlias(roleName));
      if (!matches || matches.size !== 1) {
        return {
          personaId: null,
          reason: matches
            ? 'trusted_role_name_ambiguous'
            : 'trusted_role_name_unmapped',
        };
      }
      mappedPersonas.add([...matches][0]);
    }
    if (
      mappedPersonas.size !== 1 ||
      !mappedPersonas.has(evidencePersonas[0])
    ) {
      return {
        personaId: null,
        reason: 'trusted_role_name_evidence_mismatch',
      };
    }
    return {
      personaId: evidencePersonas[0],
      reason: 'trusted_role_mapping_unique',
    };
  }

  private enqueueReextraction(candidate: RepairCandidate): number {
    let queued = 0;
    const selected = new Set(candidate.plan.reextractTurnIds);
    for (const evidence of candidate.evidence) {
      if (!selected.has(evidence.turnId)) continue;
      const jobId = stableRepairJobId(evidence.turnId);
      if (this.lifecycleStore.getJob(jobId)) continue;
      this.lifecycleStore.enqueueJob({
        id: jobId,
        jobType: 'extract_turn',
        userId: candidate.plan.userId,
        namespace: candidate.plan.namespace,
        payload: {
          principalId: candidate.plan.userId,
          turnId: evidence.turnId,
          sessionId: evidence.sessionId,
          sessionExternalId: evidence.sessionExternalId,
          personaId: evidence.personaId,
          projectId: evidence.projectId,
          identityStatus: evidence.identityStatus,
          repairSourceMemoryId: candidate.plan.memoryId,
          repairReason: 'schema28_condition_coverage',
        },
        priority: 11,
        maxAttempts: 5,
      });
      queued += 1;
    }
    return queued;
  }

  private invalidateArtifacts(
    memoryId: string,
    userId: string,
    rebuildActiveLexical: boolean,
  ): { consolidations: number; indexes: number; relations: number } {
    const consolidationRows = this.database.prepare(
      `SELECT DISTINCT d.id, d.memory_id
       FROM derived_consolidations d
       JOIN derived_consolidation_sources source
         ON source.consolidation_id = d.id
       JOIN memory_versions version
         ON version.id = source.memory_version_id
       WHERE version.memory_item_id = ?
         AND d.user_id = ?
         AND d.status = 'active'`,
    ).all(memoryId, userId) as DatabaseRow[];
    const derivedMemoryIds = unique(
      consolidationRows.flatMap((row) =>
        nullableText(row.memory_id) ? [cleanText(row.memory_id)] : [],
      ),
    );
    const targetIds = unique([memoryId, ...derivedMemoryIds]);
    const timestamp = new Date().toISOString();
    let indexChanges = 0;
    let relationChanges = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of consolidationRows) {
        this.database.prepare(
          `UPDATE derived_consolidations
           SET status = 'stale', stale_at = ?,
               last_error = 'schema28_long_memory_defect_repair'
           WHERE id = ? AND status = 'active'`,
        ).run(timestamp, cleanText(row.id));
      }
      for (const derivedId of derivedMemoryIds) {
        this.database.prepare(
          `UPDATE memories
           SET status = 'archived', updated_at = ?
           WHERE id = ? AND user_id = ?`,
        ).run(timestamp, derivedId, userId);
        this.database.prepare(
          `UPDATE memory_items
           SET status = 'archived', archived_at = ?,
               archive_reason = 'schema28_scope_repair', updated_at = ?
           WHERE id = ? AND user_id = ?`,
        ).run(timestamp, timestamp, derivedId, userId);
      }
      for (const id of targetIds) {
        for (const table of [
          'memory_embeddings',
          'memory_dense_lsh',
          'memory_ann_index',
          'memory_term_index',
          'memories_fts',
        ]) {
          indexChanges += Number(
            this.database.prepare(
              `DELETE FROM ${table} WHERE memory_id = ?`,
            ).run(id).changes,
          );
        }
        relationChanges += Number(
          this.database.prepare(
            `DELETE FROM memory_edges
             WHERE from_memory_item_id = ? OR to_memory_item_id = ?`,
          ).run(id, id).changes,
        );
        relationChanges += Number(
          this.database.prepare(
            `DELETE FROM memory_relations
             WHERE from_memory_id = ? OR to_memory_id = ?`,
          ).run(id, id).changes,
        );
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }

    if (rebuildActiveLexical) {
      const memory = this.memoryStore.get(memoryId, true, userId);
      if (memory?.status === 'active') {
        this.retrievalIndex.upsert(
          memory.id,
          [
            memory.title,
            memory.content,
            memory.summary,
            memory.tags.join(' '),
          ].join('\n'),
          memory.updatedAt,
        );
        this.database.prepare(
          `INSERT INTO memories_fts (
             memory_id, user_id, namespace, kind,
             title, content, summary, tags
           )
           SELECT id, user_id, namespace, kind,
                  title, content, summary, tags_json
           FROM memories
           WHERE id = ? AND user_id = ? AND status = 'active'`,
        ).run(memoryId, userId);
      }
    }
    return {
      consolidations: consolidationRows.length,
      indexes: indexChanges,
      relations: relationChanges,
    };
  }

  private recordRepairAudit(plan: Schema28RepairItem): void {
    this.database.prepare(
      `INSERT INTO audit_log (
         id, action, memory_id, user_id, detail_json, created_at
       )
       SELECT COALESCE(MAX(id), 0) + 1,
              'schema28_long_memory_defect_repair', ?, ?, ?, ?
       FROM audit_log
       WHERE user_id = ?`,
    ).run(
      plan.memoryId,
      plan.userId,
      JSON.stringify({
        action: plan.action,
        reason: plan.reason,
        targetPersonaId: plan.targetPersonaId,
        roleNames: plan.roleNames,
        missingQualifiers: plan.missingQualifiers,
        reextractTurnIds: plan.reextractTurnIds,
      }),
      new Date().toISOString(),
      plan.userId,
    );
  }
}
