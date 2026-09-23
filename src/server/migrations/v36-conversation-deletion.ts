/**
 * v36 · 删除回执 / 屏障 / 证据证明 / 记忆重算 / 维护任务 / 导入状态
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
  V36_CONVERSATION_DELETION_TRIGGERS,
} from '../schema-sql.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV36(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'conversation_sessions',
    'deletion_generation',
    `ALTER TABLE conversation_sessions
         ADD COLUMN deletion_generation INTEGER NOT NULL DEFAULT 1
           CHECK (deletion_generation > 0)`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'deleted_at',
    'ALTER TABLE conversation_sessions ADD COLUMN deleted_at TEXT',
  );
  database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_deletion_receipts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        resource_type TEXT NOT NULL
          CHECK (resource_type IN ('message', 'conversation')),
        resource_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE RESTRICT,
        memory_policy TEXT NOT NULL
          CHECK (
            memory_policy IN (
              'retain_derived_memories', 'forget_derived_memories'
            )
          ),
        reason_hash TEXT NOT NULL,
        request_payload_hash TEXT NOT NULL,
        affected_message_ids_json TEXT NOT NULL
          CHECK (
            json_valid(affected_message_ids_json)
            AND json_type(affected_message_ids_json) = 'array'
          ),
        memory_action_request_ids_json TEXT NOT NULL
          CHECK (
            json_valid(memory_action_request_ids_json)
            AND json_type(memory_action_request_ids_json) = 'array'
          ),
        cancelled_round_ids_json TEXT NOT NULL
          CHECK (
            json_valid(cancelled_round_ids_json)
            AND json_type(cancelled_round_ids_json) = 'array'
          ),
        purge_job_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, client_request_id),
        UNIQUE(user_id, namespace, resource_type, resource_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_deletion_receipts_owner_idx
        ON conversation_deletion_receipts(
          user_id, namespace, created_at DESC
        );

      CREATE TABLE IF NOT EXISTS conversation_deletion_barriers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        conversation_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE RESTRICT,
        round_id TEXT
          REFERENCES conversation_rounds(id) ON DELETE RESTRICT,
        resource_type TEXT NOT NULL
          CHECK (resource_type IN ('round', 'conversation')),
        resource_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, resource_type, resource_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_deletion_barriers_expiry_idx
        ON conversation_deletion_barriers(expires_at, user_id, namespace);

      CREATE TABLE IF NOT EXISTS conversation_deleted_evidence_proofs (
        id TEXT PRIMARY KEY,
        deletion_receipt_id TEXT NOT NULL
          REFERENCES conversation_deletion_receipts(id) ON DELETE RESTRICT,
        memory_version_id TEXT
          REFERENCES memory_versions(id) ON DELETE SET NULL,
        former_turn_hash TEXT NOT NULL,
        proof_type TEXT NOT NULL
          CHECK (proof_type IN ('retained', 'revoked')),
        created_at TEXT NOT NULL,
        UNIQUE(
          deletion_receipt_id, memory_version_id, former_turn_hash, proof_type
        )
      );

      CREATE TABLE IF NOT EXISTS conversation_memory_recomputations (
        id TEXT PRIMARY KEY,
        deletion_receipt_id TEXT NOT NULL
          REFERENCES conversation_deletion_receipts(id) ON DELETE RESTRICT,
        memory_item_id TEXT NOT NULL
          REFERENCES memory_items(id) ON DELETE RESTRICT,
        action TEXT NOT NULL
          CHECK (action IN ('retained', 'recomputed', 'tombstoned')),
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'completed', 'quarantined', 'dead')),
        remaining_evidence_count INTEGER NOT NULL DEFAULT 0
          CHECK (remaining_evidence_count >= 0),
        new_memory_version_id TEXT
          REFERENCES memory_versions(id) ON DELETE SET NULL,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(deletion_receipt_id, memory_item_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_memory_recompute_status_idx
        ON conversation_memory_recomputations(status, updated_at ASC);

      CREATE TABLE IF NOT EXISTS conversation_maintenance_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        job_type TEXT NOT NULL
          CHECK (job_type IN ('memory_recompute', 'chat_purge')),
        deletion_receipt_id TEXT NOT NULL
          REFERENCES conversation_deletion_receipts(id) ON DELETE RESTRICT,
        payload_json TEXT NOT NULL
          CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS conversation_maintenance_jobs_ready_idx
        ON conversation_maintenance_jobs(status, available_at ASC);

      CREATE TABLE IF NOT EXISTS conversation_import_states (
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        import_id TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('dry_run', 'commit')),
        next_batch_index INTEGER NOT NULL DEFAULT 0
          CHECK (next_batch_index >= 0),
        previous_payload_hash TEXT,
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, namespace, import_id, lane)
      );

      CREATE TABLE IF NOT EXISTS conversation_import_receipts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        import_id TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('dry_run', 'commit')),
        batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
        batch_cursor_in TEXT,
        payload_hash TEXT NOT NULL,
        batch_cursor_out TEXT NOT NULL,
        is_last_batch INTEGER NOT NULL CHECK (is_last_batch IN (0, 1)),
        stats_json TEXT NOT NULL
          CHECK (json_valid(stats_json) AND json_type(stats_json) = 'object'),
        created_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, import_id, lane, batch_index)
      );

      CREATE INDEX IF NOT EXISTS conversation_import_receipts_owner_idx
        ON conversation_import_receipts(
          user_id, namespace, import_id, lane, batch_index ASC
        );

      CREATE TABLE IF NOT EXISTS conversation_import_sessions (
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        import_id TEXT NOT NULL,
        external_session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE RESTRICT,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(user_id, namespace, import_id, external_session_id),
        UNIQUE(user_id, namespace, external_session_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_import_messages (
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        import_id TEXT NOT NULL,
        external_session_id TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        external_round_id TEXT NOT NULL,
        message_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE RESTRICT,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(
          user_id, namespace, import_id,
          external_session_id, external_message_id
        ),
        UNIQUE(user_id, namespace, external_session_id, external_message_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_import_messages_round_idx
        ON conversation_import_messages(
          user_id, namespace, external_session_id, external_round_id
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
  for (const trigger of V36_CONVERSATION_DELETION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  database.exec('PRAGMA user_version = 36;');
}
