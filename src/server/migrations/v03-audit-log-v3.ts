/**
 * v3 · 审计日志表重建（v3）
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV3(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE audit_log_v3 (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id INTEGER NOT NULL,
        action TEXT NOT NULL,
        memory_id TEXT,
        user_id TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(user_id, id)
      );

      INSERT INTO audit_log_v3 (
        id, action, memory_id, user_id, detail_json, created_at
      )
      SELECT id, action, memory_id, user_id, detail_json, created_at
      FROM audit_log;

      DROP TABLE audit_log;
      ALTER TABLE audit_log_v3 RENAME TO audit_log;

      CREATE INDEX audit_created_idx
        ON audit_log(created_at DESC);
      CREATE INDEX audit_user_idx
        ON audit_log(user_id, id DESC);

      PRAGMA user_version = 3;
      `);
}
