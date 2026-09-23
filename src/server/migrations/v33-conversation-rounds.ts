/**
 * v33 · 会话轮次表与租约索引
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import {
  V32_CONVERSATION_TRIGGERS,
  V33_CONVERSATION_ROUND_TRIGGERS,
} from '../schema-sql.js';
export function applyV33(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_rounds (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        request_payload_hash TEXT NOT NULL,
        user_message_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE RESTRICT,
        status TEXT NOT NULL
          CHECK (
            status IN (
              'accepted', 'understanding', 'recalling', 'generating',
              'completed', 'failed', 'interrupted', 'deleted'
            )
          ),
        persona_profile_version_used INTEGER NOT NULL
          CHECK (persona_profile_version_used > 0),
        active_assistant_message_id TEXT
          REFERENCES conversation_turns(id) ON DELETE SET NULL,
        current_attempt_id TEXT,
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
        failure_code TEXT,
        failure_message TEXT,
        failure_retryable INTEGER
          CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1)),
        failure_stage TEXT,
        request_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(conversation_id, client_message_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS conversation_rounds_client_message_idx
        ON conversation_rounds(conversation_id, client_message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_rounds_single_flight_idx
        ON conversation_rounds(conversation_id)
        WHERE status IN (
          'accepted', 'understanding', 'recalling', 'generating'
        );
      CREATE INDEX IF NOT EXISTS conversation_rounds_tenant_idx
        ON conversation_rounds(
          user_id, namespace, conversation_id, created_at DESC
        );

      CREATE TABLE IF NOT EXISTS conversation_round_attempts (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL
          REFERENCES conversation_rounds(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        attempt_type TEXT NOT NULL DEFAULT 'initial'
          CHECK (attempt_type IN ('initial', 'retry', 'regenerate')),
        status TEXT NOT NULL
          CHECK (
            status IN (
              'accepted', 'running', 'completed', 'failed',
              'interrupted', 'deleted'
            )
          ),
        lease_owner TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        request_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        failure_code TEXT,
        failure_message TEXT,
        failure_retryable INTEGER
          CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1)),
        failure_stage TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE(round_id, attempt_number)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS conversation_round_attempts_number_idx
        ON conversation_round_attempts(round_id, attempt_number);
      CREATE INDEX IF NOT EXISTS conversation_round_attempts_lease_idx
        ON conversation_round_attempts(
          status, lease_expires_at, heartbeat_at
        );

      CREATE TABLE IF NOT EXISTS conversation_round_events (
        round_id TEXT NOT NULL
          REFERENCES conversation_rounds(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        event_id TEXT NOT NULL UNIQUE,
        attempt_id TEXT
          REFERENCES conversation_round_attempts(id) ON DELETE SET NULL,
        request_id TEXT NOT NULL,
        event_type TEXT NOT NULL
          CHECK (
            event_type IN (
              'turn.accepted', 'turn.stage', 'assistant.delta',
              'assistant.action', 'turn.completed', 'turn.failed',
              'turn.interrupted', 'turn.deleted'
            )
          ),
        data_json TEXT NOT NULL
          CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
        contains_body INTEGER NOT NULL DEFAULT 0
          CHECK (contains_body IN (0, 1)),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(round_id, sequence)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS conversation_round_events_sequence_idx
        ON conversation_round_events(round_id, sequence);
      CREATE INDEX IF NOT EXISTS conversation_round_events_expiry_idx
        ON conversation_round_events(expires_at, contains_body);
      `);
  for (const trigger of V32_CONVERSATION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  for (const trigger of V33_CONVERSATION_ROUND_TRIGGERS) {
    database.exec(trigger.sql);
  }
  database.exec('PRAGMA user_version = 33;');
}
