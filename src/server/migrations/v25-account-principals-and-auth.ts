/**
 * v25 · 账号主体 / 凭据 / 人设绑定表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
import { backfillLegacyPrincipals } from '../schema-backfill.js';
export function applyV25(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      CREATE TABLE IF NOT EXISTS account_principals (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        disabled_at TEXT
      );

      CREATE INDEX IF NOT EXISTS account_principals_status_idx
        ON account_principals(status, created_at ASC);

      CREATE TABLE IF NOT EXISTS auth_credentials (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        label TEXT NOT NULL,
        secret_hash BLOB NOT NULL
          CHECK (length(secret_hash) = 32),
        secret_hint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'revoked', 'expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        last_used_at TEXT,
        CHECK (
          (status = 'revoked' AND revoked_at IS NOT NULL)
          OR status != 'revoked'
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS auth_credentials_hash_idx
        ON auth_credentials(secret_hash);
      CREATE INDEX IF NOT EXISTS auth_credentials_principal_idx
        ON auth_credentials(principal_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS client_persona_bindings (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        client_type TEXT NOT NULL,
        client_instance_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(client_type, client_instance_id, persona_id)
      );

      CREATE INDEX IF NOT EXISTS client_persona_principal_idx
        ON client_persona_bindings(
          principal_id,
          client_type,
          status,
          updated_at DESC
        );

      CREATE TABLE IF NOT EXISTS identity_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('success', 'denied', 'failure')),
        principal_id TEXT
          REFERENCES account_principals(id) ON DELETE SET NULL,
        credential_id TEXT
          REFERENCES auth_credentials(id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS identity_audit_created_idx
        ON identity_audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS identity_audit_principal_idx
        ON identity_audit_log(principal_id, created_at DESC);
      `);
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'persona_id',
    `ALTER TABLE conversation_sessions
         ADD COLUMN persona_id TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'identity_source',
    `ALTER TABLE conversation_sessions
         ADD COLUMN identity_source TEXT NOT NULL DEFAULT 'legacy'`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'identity_status',
    `ALTER TABLE conversation_sessions
         ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'legacy'
           CHECK (
             identity_status IN ('complete', 'degraded', 'legacy')
           )`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'round_id',
    `ALTER TABLE conversation_turns
         ADD COLUMN round_id TEXT`,
  );
  addColumnIfMissing(
    database,
    'outbox_events',
    'user_id',
    `ALTER TABLE outbox_events
         ADD COLUMN user_id TEXT`,
  );
  addColumnIfMissing(
    database,
    'outbox_events',
    'namespace',
    `ALTER TABLE outbox_events
         ADD COLUMN namespace TEXT`,
  );
  database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_round_role_idx
        ON conversation_turns(session_id, round_id, role)
        WHERE round_id IS NOT NULL;

      UPDATE outbox_events
      SET
        user_id = COALESCE(
          user_id,
          CASE aggregate_type
            WHEN 'turn' THEN (
              SELECT t.user_id
              FROM conversation_turns t
              WHERE t.id = outbox_events.aggregate_id
            )
            WHEN 'memory_candidate' THEN (
              SELECT c.user_id
              FROM memory_candidates c
              WHERE c.id = outbox_events.aggregate_id
            )
            WHEN 'memory_event' THEN (
              SELECT e.user_id
              FROM memory_events e
              WHERE e.id = outbox_events.aggregate_id
            )
          END
        ),
        namespace = COALESCE(
          namespace,
          CASE aggregate_type
            WHEN 'turn' THEN (
              SELECT t.namespace
              FROM conversation_turns t
              WHERE t.id = outbox_events.aggregate_id
            )
            WHEN 'memory_candidate' THEN (
              SELECT c.namespace
              FROM memory_candidates c
              WHERE c.id = outbox_events.aggregate_id
            )
            WHEN 'memory_event' THEN (
              SELECT i.namespace
              FROM memory_events e
              JOIN memory_items i ON i.id = e.memory_item_id
              WHERE e.id = outbox_events.aggregate_id
            )
          END
        )
      WHERE user_id IS NULL OR namespace IS NULL;

      CREATE INDEX IF NOT EXISTS outbox_events_scope_idx
        ON outbox_events(
          user_id,
          namespace,
          status,
          available_at ASC
        );
      `);
  backfillLegacyPrincipals(database, new Date().toISOString());
  database.exec('PRAGMA user_version = 25;');
}
