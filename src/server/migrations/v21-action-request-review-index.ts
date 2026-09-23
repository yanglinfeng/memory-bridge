/**
 * v21 · 动作请求复核索引
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV21(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'memory_action_requests',
    'review_token',
    `ALTER TABLE memory_action_requests
         ADD COLUMN review_token TEXT`,
  );
  addColumnIfMissing(
    database,
    'memory_action_requests',
    'review_claimed_at',
    `ALTER TABLE memory_action_requests
         ADD COLUMN review_claimed_at TEXT`,
  );
  database.exec(`
      CREATE INDEX IF NOT EXISTS memory_action_requests_review_idx
        ON memory_action_requests(
          user_id, status, review_claimed_at, created_at DESC
        );

      PRAGMA user_version = 21;
      `);
}
