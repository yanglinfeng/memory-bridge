/**
 * v6 · 记忆条目 / 版本 / 任务表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV6(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'memory_candidates',
    'explicit_correction',
    `ALTER TABLE memory_candidates
         ADD COLUMN explicit_correction INTEGER NOT NULL DEFAULT 0
           CHECK (explicit_correction IN (0, 1))`,
  );
  addColumnIfMissing(
    database,
    'memory_candidates',
    'resolved_memory_item_id',
    `ALTER TABLE memory_candidates
         ADD COLUMN resolved_memory_item_id TEXT
           REFERENCES memory_items(id) ON DELETE SET NULL`,
  );
  addColumnIfMissing(
    database,
    'memory_candidates',
    'resolved_at',
    `ALTER TABLE memory_candidates
         ADD COLUMN resolved_at TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'predicate_key',
    `ALTER TABLE memory_items
         ADD COLUMN predicate_key TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'normalized_value_hash',
    `ALTER TABLE memory_items
         ADD COLUMN normalized_value_hash TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'normalized_value',
    `ALTER TABLE memory_items
         ADD COLUMN normalized_value TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'predicate_cardinality',
    `ALTER TABLE memory_items
         ADD COLUMN predicate_cardinality TEXT NOT NULL DEFAULT 'single'
           CHECK (predicate_cardinality IN ('single', 'set', 'event'))`,
  );
  addColumnIfMissing(
    database,
    'memory_items',
    'observation_count',
    `ALTER TABLE memory_items
         ADD COLUMN observation_count INTEGER NOT NULL DEFAULT 1
           CHECK (observation_count > 0)`,
  );
  addColumnIfMissing(
    database,
    'memory_versions',
    'superseded_at',
    `ALTER TABLE memory_versions
         ADD COLUMN superseded_at TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_versions',
    'predicate_key',
    `ALTER TABLE memory_versions
         ADD COLUMN predicate_key TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_versions',
    'namespace',
    `ALTER TABLE memory_versions
         ADD COLUMN namespace TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_versions',
    'kind',
    `ALTER TABLE memory_versions
         ADD COLUMN kind TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_versions',
    'normalized_value_hash',
    `ALTER TABLE memory_versions
         ADD COLUMN normalized_value_hash TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_versions',
    'normalized_value',
    `ALTER TABLE memory_versions
         ADD COLUMN normalized_value TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_versions',
    'predicate_cardinality',
    `ALTER TABLE memory_versions
         ADD COLUMN predicate_cardinality TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_jobs',
    'lease_owner',
    `ALTER TABLE memory_jobs
         ADD COLUMN lease_owner TEXT`,
  );
  database.exec(`
      UPDATE memory_items
      SET predicate_key = stable_key
      WHERE predicate_key IS NULL;

      UPDATE memory_versions
      SET
        namespace = COALESCE(
          namespace,
          (
            SELECT namespace
            FROM memory_items
            WHERE memory_items.id = memory_versions.memory_item_id
          )
        ),
        kind = COALESCE(
          kind,
          (
            SELECT kind
            FROM memory_items
            WHERE memory_items.id = memory_versions.memory_item_id
          )
        );

      CREATE INDEX IF NOT EXISTS memory_items_predicate_idx
        ON memory_items(
          user_id,
          namespace,
          predicate_key,
          status,
          updated_at DESC
        );
      CREATE INDEX IF NOT EXISTS memory_items_value_idx
        ON memory_items(
          user_id,
          namespace,
          predicate_key,
          normalized_value_hash
        );
      CREATE INDEX IF NOT EXISTS memory_candidates_resolution_idx
        ON memory_candidates(state, resolved_at, created_at ASC);

      PRAGMA user_version = 6;
      `);
}
