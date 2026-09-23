/**
 * v8 · 词项索引
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV8(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS memory_term_index (
        memory_id TEXT NOT NULL
          REFERENCES memories(id) ON DELETE CASCADE,
        index_model TEXT NOT NULL,
        term TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, index_model, term)
      );

      CREATE INDEX IF NOT EXISTS memory_term_lookup_idx
        ON memory_term_index(index_model, term, memory_id);

      PRAGMA user_version = 8;
      `);
}
