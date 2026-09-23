/**
 * v14 · 稠密 LSH 代际唯一键
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV14(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'memory_embeddings',
    'generation_key',
    `ALTER TABLE memory_embeddings
         ADD COLUMN generation_key TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_dense_lsh',
    'generation_key',
    `ALTER TABLE memory_dense_lsh
         ADD COLUMN generation_key TEXT`,
  );
  addColumnIfMissing(
    database,
    'dense_index_state',
    'generation_key',
    `ALTER TABLE dense_index_state
         ADD COLUMN generation_key TEXT`,
  );
  database.exec(`
      UPDATE memory_dense_lsh
      SET generation_key = 'legacy-unknown'
      WHERE generation_key IS NULL;

      UPDATE memory_embeddings
      SET generation_key = 'legacy-unknown'
      WHERE generation_key IS NULL;

      UPDATE dense_index_state
      SET generation_key = 'legacy-unknown'
      WHERE generation_key IS NULL;

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_generation_key_idx
        ON memory_dense_lsh(
          embedding_model,
          index_version,
          generation_key,
          dimensions,
          band,
          bucket,
          memory_id
        );

      PRAGMA user_version = 14;
      `);
}
