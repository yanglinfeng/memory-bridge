/**
 * v17 · 候选 stableKey 索引
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV17(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'extraction_runs',
    'extractor_id',
    `ALTER TABLE extraction_runs
         ADD COLUMN extractor_id TEXT NOT NULL DEFAULT 'memory-extractor'`,
  );
  addColumnIfMissing(
    database,
    'extraction_runs',
    'extractor_version',
    `ALTER TABLE extraction_runs
         ADD COLUMN extractor_version TEXT NOT NULL DEFAULT 'v1'`,
  );
  addColumnIfMissing(
    database,
    'memory_candidates',
    'stable_key',
    `ALTER TABLE memory_candidates
         ADD COLUMN stable_key TEXT NOT NULL DEFAULT ''`,
  );
  database.exec(`
      UPDATE memory_candidates
      SET stable_key =
        scope_type || '::' || scope_key || '::' || normalized_key
      WHERE stable_key = '';

      CREATE INDEX IF NOT EXISTS memory_candidates_stable_key_idx
        ON memory_candidates(
          user_id, namespace, scope_type, scope_key, stable_key
        );

      PRAGMA user_version = 17;
      `);
}
