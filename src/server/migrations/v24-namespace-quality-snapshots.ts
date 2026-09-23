/**
 * v24 · 命名空间质量快照与灰度状态
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
import { backfillTombstoneSemanticFingerprints } from '../tombstone-policy.js';
export function applyV24(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'memory_tombstones',
    'kind',
    `ALTER TABLE memory_tombstones
         ADD COLUMN kind TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_tombstones',
    'normalized_key',
    `ALTER TABLE memory_tombstones
         ADD COLUMN normalized_key TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_tombstones',
    'normalized_value',
    `ALTER TABLE memory_tombstones
         ADD COLUMN normalized_value TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_tombstones',
    'semantic_fingerprint',
    `ALTER TABLE memory_tombstones
         ADD COLUMN semantic_fingerprint TEXT`,
  );
  database.exec(`
      UPDATE memory_tombstones
      SET
        kind = COALESCE(
          kind,
          (
            SELECT i.kind
            FROM memory_items i
            WHERE i.id = memory_tombstones.memory_item_id
          )
        ),
        normalized_key = COALESCE(
          normalized_key,
          (
            SELECT i.predicate_key
            FROM memory_items i
            WHERE i.id = memory_tombstones.memory_item_id
          )
        ),
        normalized_value = COALESCE(
          normalized_value,
          (
            SELECT i.normalized_value
            FROM memory_items i
            WHERE i.id = memory_tombstones.memory_item_id
          )
        )
      WHERE memory_item_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS memory_tombstones_normalized_key_idx
        ON memory_tombstones(
          user_id,
          namespace,
          scope_type,
          scope_key,
          normalized_key,
          restored_at
        );

      CREATE TABLE IF NOT EXISTS namespace_quality_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        extraction_precision REAL NOT NULL
          CHECK (extraction_precision >= 0 AND extraction_precision <= 1),
        candidate_recall REAL NOT NULL
          CHECK (candidate_recall >= 0 AND candidate_recall <= 1),
        credential_saves INTEGER NOT NULL
          CHECK (credential_saves >= 0),
        conflict_accuracy REAL NOT NULL
          CHECK (conflict_accuracy >= 0 AND conflict_accuracy <= 1),
        semantic_duplicate_rate REAL NOT NULL
          CHECK (
            semantic_duplicate_rate >= 0
            AND semantic_duplicate_rate <= 1
          ),
        extraction_precision_samples INTEGER NOT NULL
          CHECK (extraction_precision_samples >= 0),
        candidate_recall_samples INTEGER NOT NULL
          CHECK (candidate_recall_samples >= 0),
        credential_samples INTEGER NOT NULL
          CHECK (credential_samples >= 0),
        conflict_samples INTEGER NOT NULL
          CHECK (conflict_samples >= 0),
        semantic_duplicate_samples INTEGER NOT NULL
          CHECK (semantic_duplicate_samples >= 0),
        passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
        thresholds_json TEXT NOT NULL,
        threshold_results_json TEXT NOT NULL,
        failed_metrics_json TEXT NOT NULL,
        model_versions_json TEXT NOT NULL,
        prompt_versions_json TEXT NOT NULL,
        evaluator_version TEXT NOT NULL,
        dataset_id TEXT NOT NULL,
        dataset_sha256 TEXT,
        evaluated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS namespace_quality_snapshots_scope_idx
        ON namespace_quality_snapshots(
          user_id,
          namespace,
          evaluated_at DESC,
          created_at DESC
        );

      CREATE TABLE IF NOT EXISTS namespace_rollout_state (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        rollout_mode TEXT NOT NULL
          CHECK (rollout_mode IN ('shadow', 'auto')),
        quality_state TEXT NOT NULL
          CHECK (
            quality_state IN (
              'unassessed', 'bootstrap', 'passed', 'failed'
            )
          ),
        active_snapshot_id TEXT
          REFERENCES namespace_quality_snapshots(id)
          ON DELETE SET NULL,
        override_kind TEXT
          CHECK (
            override_kind IS NULL
            OR override_kind = 'bootstrap_auto'
          ),
        override_reason TEXT,
        override_actor TEXT,
        override_created_at TEXT,
        override_expires_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, namespace)
      );

      CREATE INDEX IF NOT EXISTS namespace_rollout_mode_idx
        ON namespace_rollout_state(
          rollout_mode,
          quality_state,
          updated_at DESC
        );

      CREATE TABLE IF NOT EXISTS namespace_recall_shadow_comparisons (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        new_result_ids_json TEXT NOT NULL,
        legacy_result_ids_json TEXT NOT NULL,
        new_only_ids_json TEXT NOT NULL,
        legacy_only_ids_json TEXT NOT NULL,
        injected_result_ids_json TEXT NOT NULL,
        injection_path TEXT NOT NULL
          CHECK (
            injection_path IN ('hybrid', 'legacy_fts', 'none')
          ),
        effective_mode TEXT NOT NULL
          CHECK (effective_mode IN ('off', 'shadow', 'auto')),
        decision_reason TEXT NOT NULL,
        quality_state TEXT NOT NULL
          CHECK (
            quality_state IN (
              'unassessed', 'bootstrap', 'passed', 'failed'
            )
          ),
        snapshot_id TEXT
          REFERENCES namespace_quality_snapshots(id)
          ON DELETE SET NULL,
        new_recall_quality TEXT NOT NULL
          CHECK (
            new_recall_quality IN (
              'full', 'degraded', 'unavailable'
            )
          ),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS namespace_recall_shadow_scope_idx
        ON namespace_recall_shadow_comparisons(
          user_id,
          namespace,
          created_at DESC
        );

      PRAGMA user_version = 24;
      `);
  const activeTombstoneIds = (
    database
      .prepare(
        `SELECT id
             FROM memory_tombstones
             WHERE restored_at IS NULL
             ORDER BY id ASC`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => String(row.id ?? '').trim())
    .filter(Boolean);
  backfillTombstoneSemanticFingerprints(database, {
    tombstoneIds: activeTombstoneIds,
    requireComplete: true,
  });
}
