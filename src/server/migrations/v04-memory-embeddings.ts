/**
 * v4 · 记忆向量表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV4(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE memory_embeddings (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        embedding BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, model)
      );

      CREATE INDEX memory_embeddings_model_idx
        ON memory_embeddings(model, updated_at DESC);

      PRAGMA user_version = 4;
      `);
}
