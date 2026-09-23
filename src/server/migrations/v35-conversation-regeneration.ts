/**
 * v35 · 重新生成请求表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import {
  V32_CONVERSATION_TRIGGERS,
  V33_CONVERSATION_ROUND_TRIGGERS,
  V35_CONVERSATION_REGENERATION_TRIGGERS,
} from '../schema-sql.js';
export function applyV35(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      DROP INDEX IF EXISTS conversation_turns_round_role_idx;

      CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_round_user_idx
        ON conversation_turns(session_id, round_id)
        WHERE round_id IS NOT NULL AND role = 'user';
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_generation_variant_idx
        ON conversation_turns(
          session_id, generation_group_id, variant_index
        )
        WHERE role = 'assistant' AND generation_group_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_generation_active_idx
        ON conversation_turns(session_id, generation_group_id)
        WHERE role = 'assistant'
          AND generation_group_id IS NOT NULL
          AND is_active_variant = 1
          AND message_status != 'deleted';

      CREATE TABLE IF NOT EXISTS conversation_regeneration_requests (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        conversation_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        round_id TEXT NOT NULL
          REFERENCES conversation_rounds(id) ON DELETE CASCADE,
        client_request_id TEXT NOT NULL,
        source_assistant_message_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE RESTRICT,
        request_payload_hash TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_round_attempts(id) ON DELETE CASCADE,
        status TEXT NOT NULL
          CHECK (
            status IN (
              'accepted', 'running', 'completed', 'failed',
              'interrupted', 'deleted'
            )
          ),
        new_assistant_message_id TEXT
          REFERENCES conversation_turns(id) ON DELETE SET NULL,
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(user_id, namespace, client_request_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_regeneration_request_idx
        ON conversation_regeneration_requests(
          user_id, namespace, conversation_id, created_at DESC
        );
      `);
  for (const trigger of V32_CONVERSATION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  for (const trigger of V33_CONVERSATION_ROUND_TRIGGERS) {
    database.exec(trigger.sql);
  }
  for (const trigger of V35_CONVERSATION_REGENERATION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  database.exec('PRAGMA user_version = 35;');
}
