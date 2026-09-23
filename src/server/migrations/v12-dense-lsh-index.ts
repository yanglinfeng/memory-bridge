/**
 * v12 · 稠密 LSH 索引表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV12(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS memory_dense_lsh (
        memory_id TEXT NOT NULL
          REFERENCES memories(id) ON DELETE CASCADE,
        embedding_model TEXT NOT NULL,
        index_version TEXT NOT NULL,
        band INTEGER NOT NULL CHECK (band >= 0),
        bucket TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(
          memory_id,
          embedding_model,
          index_version,
          band
        )
      );

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_bucket_idx
        ON memory_dense_lsh(
          embedding_model,
          index_version,
          band,
          bucket,
          memory_id
        );

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_watermark_idx
        ON memory_dense_lsh(
          embedding_model,
          index_version,
          updated_at,
          memory_id
        );

      PRAGMA user_version = 12;
      `);
}
