/**
 * v11 · 发件箱事件表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV11(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'outbox_events',
    'lease_owner',
    `ALTER TABLE outbox_events
         ADD COLUMN lease_owner TEXT`,
  );
  addColumnIfMissing(
    database,
    'outbox_events',
    'max_attempts',
    `ALTER TABLE outbox_events
         ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 10
           CHECK (max_attempts > 0)`,
  );
  addColumnIfMissing(
    database,
    'outbox_events',
    'updated_at',
    `ALTER TABLE outbox_events
         ADD COLUMN updated_at TEXT`,
  );
  database.exec(`
      UPDATE outbox_events
      SET updated_at = COALESCE(updated_at, created_at);

      CREATE INDEX IF NOT EXISTS outbox_events_lease_idx
        ON outbox_events(status, lease_until, available_at);

      PRAGMA user_version = 11;
      `);
}
