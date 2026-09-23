/**
 * v23 · 清理 legacy 稠密 LSH 索引
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV23(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      DROP INDEX IF EXISTS memory_dense_lsh_watermark_idx;
      DROP INDEX IF EXISTS memory_dense_lsh_generation_idx;
      DROP INDEX IF EXISTS memory_dense_lsh_generation_key_idx;
      DROP INDEX IF EXISTS memory_dense_lsh_revision_idx;
      PRAGMA user_version = 23;
      `);
}
