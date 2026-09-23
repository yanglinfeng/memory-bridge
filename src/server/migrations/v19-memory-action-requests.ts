/**
 * v19 · 记忆动作请求表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV19(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS memory_action_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        request_key TEXT NOT NULL,
        action TEXT NOT NULL
          CHECK (action IN ('remember', 'correct', 'forget')),
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'completed', 'rejected', 'failed')),
        target_query TEXT NOT NULL DEFAULT '',
        target_memory_id TEXT
          REFERENCES memories(id) ON DELETE SET NULL,
        candidate_id TEXT
          REFERENCES memory_candidates(id) ON DELETE SET NULL,
        turn_id TEXT
          REFERENCES conversation_turns(id) ON DELETE SET NULL,
        candidate_json TEXT,
        confidence REAL NOT NULL DEFAULT 0
          CHECK (confidence >= 0 AND confidence <= 1),
        sensitivity TEXT NOT NULL DEFAULT 'normal'
          CHECK (sensitivity IN ('normal', 'sensitive', 'credential')),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        error TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(user_id, namespace, request_key)
      );

      CREATE INDEX IF NOT EXISTS memory_action_requests_inbox_idx
        ON memory_action_requests(
          user_id, namespace, status, created_at DESC
        );

      PRAGMA user_version = 19;
      `);
}
