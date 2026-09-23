/**
 * v34 · 会话变更流表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV34(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_changes (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        event_type TEXT NOT NULL
          CHECK (
            event_type IN (
              'conversation.upsert', 'conversation.delete',
              'message.upsert', 'message.delete',
              'message.active_variant'
            )
          ),
        conversation_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL,
        resource_version INTEGER NOT NULL CHECK (resource_version > 0),
        occurred_at TEXT NOT NULL,
        tombstone INTEGER NOT NULL DEFAULT 0
          CHECK (tombstone IN (0, 1)),
        resource_json TEXT
          CHECK (
            resource_json IS NULL
            OR (
              json_valid(resource_json)
              AND json_type(resource_json) = 'object'
            )
          ),
        expires_at TEXT NOT NULL,
        CHECK (
          (tombstone = 1 AND resource_json IS NULL)
          OR (tombstone = 0 AND resource_json IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS conversation_changes_owner_sequence_idx
        ON conversation_changes(user_id, namespace, sequence);
      CREATE INDEX IF NOT EXISTS conversation_changes_expiry_idx
        ON conversation_changes(expires_at, user_id, namespace);
      `);
  database.exec('PRAGMA user_version = 34;');
}
