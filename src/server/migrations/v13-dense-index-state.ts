/**
 * v13 · 稠密索引状态表与代际索引
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV13(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'memory_dense_lsh',
    'dimensions',
    `ALTER TABLE memory_dense_lsh
         ADD COLUMN dimensions INTEGER`,
  );
  database.exec(`
      UPDATE memory_dense_lsh
      SET dimensions = (
        SELECT e.dimensions
        FROM memory_embeddings e
        WHERE e.memory_id = memory_dense_lsh.memory_id
          AND e.model = memory_dense_lsh.embedding_model
          AND e.text_hash = memory_dense_lsh.text_hash
      )
      WHERE dimensions IS NULL;

      CREATE TABLE IF NOT EXISTS dense_index_state (
        embedding_model TEXT NOT NULL,
        index_version TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        probed_at TEXT NOT NULL,
        PRIMARY KEY(embedding_model, index_version)
      );

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_generation_idx
        ON memory_dense_lsh(
          embedding_model,
          index_version,
          dimensions,
          updated_at,
          memory_id
        );

      PRAGMA user_version = 13;
      `);
}
