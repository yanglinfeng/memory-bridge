/**
 * v32 · 人设会话档案、项目绑定、消息动作与游标键
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { V32_CONVERSATION_TRIGGERS } from '../schema-sql.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV32(context: MigrationContext): void {
  const { database } = context;

  const contaminatedAssistantTurns = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM conversation_turns
             WHERE role = 'assistant'
               AND (
                 INSTR(content, '<|') > 0
                 OR INSTR(content, '|>') > 0
                 OR INSTR(LOWER(content), '<tool_call') > 0
                 OR INSTR(LOWER(content), '<tool_result') > 0
                 OR INSTR(
                   content, '[Memory Bridge 自动长期记忆上下文]'
                 ) > 0
                 OR INSTR(content, '_memoryContext') > 0
               )`,
      )
      .get()?.count || 0,
  );
  if (contaminatedAssistantTurns > 0) {
    throw new Error(
      `schema v32 migration blocked: assistant protocol ` +
        `contamination（${contaminatedAssistantTurns} 行）`,
    );
  }
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'title',
    'ALTER TABLE conversation_sessions ADD COLUMN title TEXT',
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'status',
    `ALTER TABLE conversation_sessions
         ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
           CHECK (status IN ('active', 'archived', 'deleted'))`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'version',
    `ALTER TABLE conversation_sessions
         ADD COLUMN version INTEGER NOT NULL DEFAULT 1
           CHECK (version > 0)`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'last_message_at',
    `ALTER TABLE conversation_sessions
         ADD COLUMN last_message_at TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'last_message_preview',
    `ALTER TABLE conversation_sessions
         ADD COLUMN last_message_preview TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'message_count',
    `ALTER TABLE conversation_sessions
         ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0
           CHECK (message_count >= 0)`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'persona_profile_version',
    `ALTER TABLE conversation_sessions
         ADD COLUMN persona_profile_version INTEGER
           CHECK (
             persona_profile_version IS NULL
             OR persona_profile_version > 0
           )`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'updated_at',
    `ALTER TABLE conversation_sessions
         ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'create_idempotency_key',
    `ALTER TABLE conversation_sessions
         ADD COLUMN create_idempotency_key TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'create_payload_hash',
    `ALTER TABLE conversation_sessions
         ADD COLUMN create_payload_hash TEXT`,
  );

  addColumnIfMissing(
    database,
    'conversation_turns',
    'message_sequence',
    `ALTER TABLE conversation_turns
         ADD COLUMN message_sequence INTEGER
           CHECK (message_sequence IS NULL OR message_sequence > 0)`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'display_content',
    `ALTER TABLE conversation_turns
         ADD COLUMN display_content TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'normalized_content',
    `ALTER TABLE conversation_turns
         ADD COLUMN normalized_content TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'message_status',
    `ALTER TABLE conversation_turns
         ADD COLUMN message_status TEXT NOT NULL DEFAULT 'completed'
           CHECK (
             message_status IN (
               'pending', 'streaming', 'completed', 'failed',
               'interrupted', 'deleted'
             )
           )`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'client_message_id',
    `ALTER TABLE conversation_turns
         ADD COLUMN client_message_id TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'message_payload_hash',
    `ALTER TABLE conversation_turns
         ADD COLUMN message_payload_hash TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'generation_group_id',
    `ALTER TABLE conversation_turns
         ADD COLUMN generation_group_id TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'variant_index',
    `ALTER TABLE conversation_turns
         ADD COLUMN variant_index INTEGER NOT NULL DEFAULT 1
           CHECK (variant_index > 0)`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'is_active_variant',
    `ALTER TABLE conversation_turns
         ADD COLUMN is_active_variant INTEGER NOT NULL DEFAULT 1
           CHECK (is_active_variant IN (0, 1))`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'completed_at',
    `ALTER TABLE conversation_turns
         ADD COLUMN completed_at TEXT`,
  );
  addColumnIfMissing(
    database,
    'conversation_turns',
    'message_version',
    `ALTER TABLE conversation_turns
         ADD COLUMN message_version INTEGER NOT NULL DEFAULT 1
           CHECK (message_version > 0)`,
  );

  database.exec(`
      CREATE TABLE IF NOT EXISTS persona_chat_profiles (
        id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        persona_id TEXT NOT NULL,
        profile_version INTEGER NOT NULL CHECK (profile_version > 0),
        display_name TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        greeting TEXT NOT NULL,
        language TEXT NOT NULL,
        capability_ids_json TEXT NOT NULL DEFAULT '[]'
          CHECK (
            json_valid(capability_ids_json)
            AND json_type(capability_ids_json) = 'array'
          ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(principal_id, persona_id, profile_version)
      );

      CREATE INDEX IF NOT EXISTS persona_chat_profiles_current_idx
        ON persona_chat_profiles(
          principal_id, persona_id, profile_version DESC
        );

      WITH ranked_personas AS (
        SELECT
          b.principal_id,
          b.persona_id,
          NULLIF(TRIM(b.display_name), '') AS display_name,
          ROW_NUMBER() OVER (
            PARTITION BY b.principal_id, b.persona_id
            ORDER BY
              CASE
                WHEN NULLIF(TRIM(b.display_name), '') IS NULL THEN 1
                ELSE 0
              END ASC,
              b.updated_at DESC,
              b.id DESC
          ) AS rank
        FROM client_persona_bindings b
        JOIN account_principals p ON p.id = b.principal_id
        WHERE b.status = 'active' AND p.status = 'active'
      )
      INSERT OR IGNORE INTO persona_chat_profiles (
        id, principal_id, persona_id, profile_version,
        display_name, system_prompt, greeting, language,
        capability_ids_json, created_at, updated_at
      )
      SELECT
        LOWER(HEX(RANDOMBLOB(16))),
        principal_id,
        persona_id,
        1,
        COALESCE(display_name, persona_id),
        '',
        '',
        'zh-Hans',
        '[]',
        STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'),
        STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM ranked_personas
      WHERE rank = 1;

      UPDATE conversation_sessions
      SET persona_profile_version = 1
      WHERE persona_profile_version IS NULL
        AND identity_status = 'complete'
        AND persona_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM persona_chat_profiles p
          WHERE p.principal_id = conversation_sessions.user_id
            AND p.persona_id = conversation_sessions.persona_id
            AND p.profile_version = 1
        );

      CREATE TABLE IF NOT EXISTS conversation_project_bindings (
        principal_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        external_project_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (principal_id, namespace, external_project_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_project_bindings_list_idx
        ON conversation_project_bindings(
          principal_id, namespace, status, last_seen_at DESC,
          external_project_id ASC
        );

      INSERT OR IGNORE INTO conversation_project_bindings (
        principal_id, namespace, external_project_id, display_name,
        status, version, created_at, updated_at, last_seen_at
      )
      SELECT
        s.user_id,
        s.namespace,
        s.project_id,
        s.project_id,
        'active',
        1,
        MIN(s.started_at),
        MAX(CASE WHEN s.updated_at = '' THEN s.started_at ELSE s.updated_at END),
        MAX(CASE WHEN s.updated_at = '' THEN s.started_at ELSE s.updated_at END)
      FROM conversation_sessions s
      JOIN account_principals p ON p.id = s.user_id
      WHERE s.identity_status = 'complete'
        AND s.project_id IS NOT NULL
        AND TRIM(s.project_id) != ''
        AND p.status = 'active'
      GROUP BY s.user_id, s.namespace, s.project_id;

      CREATE TABLE IF NOT EXISTS conversation_message_actions (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        action_index INTEGER NOT NULL CHECK (action_index >= 0),
        action_type TEXT NOT NULL
          CHECK (action_type IN ('emotion', 'motion')),
        payload_json TEXT NOT NULL
          CHECK (
            json_valid(payload_json)
            AND json_type(payload_json) = 'object'
          ),
        created_at TEXT NOT NULL,
        UNIQUE(message_id, action_index)
      );

      CREATE INDEX IF NOT EXISTS conversation_message_actions_message_idx
        ON conversation_message_actions(message_id, action_index ASC);

      CREATE TABLE IF NOT EXISTS conversation_cursor_keys (
        key_version INTEGER PRIMARY KEY AUTOINCREMENT,
        secret BLOB NOT NULL
          CHECK (typeof(secret) = 'blob' AND length(secret) = 32),
        status TEXT NOT NULL
          CHECK (status IN ('current', 'previous')),
        created_at TEXT NOT NULL,
        retired_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS conversation_cursor_keys_one_current_idx
        ON conversation_cursor_keys(status)
        WHERE status = 'current';

      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY occurred_at ASC, created_at ASC, id ASC
          ) AS sequence
        FROM conversation_turns
      )
      UPDATE conversation_turns
      SET
        message_sequence = (
          SELECT sequence FROM ranked
          WHERE ranked.id = conversation_turns.id
        ),
        display_content = content,
        client_message_id = external_id,
        message_payload_hash = content_hash,
        completed_at = created_at;

      UPDATE conversation_sessions
      SET
        message_count = (
          SELECT COUNT(*) FROM conversation_turns t
          WHERE t.session_id = conversation_sessions.id
        ),
        last_message_at = (
          SELECT t.occurred_at FROM conversation_turns t
          WHERE t.session_id = conversation_sessions.id
          ORDER BY t.message_sequence DESC LIMIT 1
        ),
        last_message_preview = (
          SELECT SUBSTR(t.display_content, 1, 160)
          FROM conversation_turns t
          WHERE t.session_id = conversation_sessions.id
          ORDER BY t.message_sequence DESC LIMIT 1
        ),
        updated_at = COALESCE(
          (
            SELECT t.created_at FROM conversation_turns t
            WHERE t.session_id = conversation_sessions.id
            ORDER BY t.message_sequence DESC LIMIT 1
          ),
          started_at
        );

      CREATE UNIQUE INDEX IF NOT EXISTS conversation_sessions_create_idempotency_idx
        ON conversation_sessions(user_id, create_idempotency_key)
        WHERE create_idempotency_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS conversation_sessions_product_list_idx
        ON conversation_sessions(
          user_id, namespace, status,
          last_message_at DESC, id DESC
        );

      CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_message_sequence_idx
        ON conversation_turns(session_id, message_sequence)
        WHERE message_sequence IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_client_message_idx
        ON conversation_turns(session_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
      `);
  for (const trigger of V32_CONVERSATION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  database.exec('PRAGMA user_version = 32;');
}
