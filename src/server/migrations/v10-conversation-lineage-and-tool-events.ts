/**
 * v10 · 会话血缘键与工具事件
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV10(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_lineage_keys (
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        key_type TEXT NOT NULL
          CHECK (key_type IN ('exact', 'suffix')),
        message_count INTEGER NOT NULL CHECK (message_count > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, fingerprint, key_type)
      );

      CREATE INDEX IF NOT EXISTS conversation_lineage_lookup_idx
        ON conversation_lineage_keys(
          fingerprint,
          key_type,
          message_count,
          updated_at DESC
        );

      CREATE TABLE IF NOT EXISTS turn_tool_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        user_turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_hash TEXT,
        result_hash TEXT,
        result_status TEXT NOT NULL
          CHECK (result_status IN ('requested', 'completed', 'failed')),
        created_at TEXT NOT NULL,
        UNIQUE(session_id, call_id)
      );

      CREATE INDEX IF NOT EXISTS turn_tool_events_turn_idx
        ON turn_tool_events(user_turn_id, created_at ASC);

      PRAGMA user_version = 10;
      `);
}
