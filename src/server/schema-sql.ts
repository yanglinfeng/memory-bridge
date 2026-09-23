/**
 * schema 层的 SQL 模板常量与纯字符串工具。
 *
 * 从 database.ts 原样搬出（零逻辑改写），仅供迁移与结构断言使用。
 * 严禁在此处引入数据库连接/IO 依赖——本模块必须是纯声明。
 */
import { createHash } from 'node:crypto';

export const V26_PROJECT_BINDING_MIGRATION_KEY_V1 =
  'v26-project-binding-no-legacy-project-v1';
export const V26_PROJECT_BINDING_SCHEMA_FINGERPRINT_V1 =
  '7a9b3d2693b082da4e76ce2347e8e112d8093b104cf2fed6f4711d00ee7a4238';

export const V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER = `
  CREATE TRIGGER memory_event_consolidation_job
  AFTER INSERT ON memory_events
  WHEN new.memory_item_id IS NOT NULL
    AND new.event_type IN (
      'created',
      'reinforced',
      'corrected',
      'updated',
      'reverted',
      'forgotten',
      'restored',
      'superseded',
      'conflicted'
    )
    AND COALESCE(
      (
        SELECT source
        FROM memories
        WHERE id = new.memory_item_id
      ),
      ''
    ) NOT IN (
      'conversation_episode',
      'hierarchical_summary',
      'consolidation'
    )
  BEGIN
    UPDATE memory_jobs
    SET status = 'completed',
        lease_until = NULL,
        lease_owner = NULL,
        last_error = 'coalesced_by_newer_memory_event:' || new.id,
        updated_at = new.created_at
    WHERE job_type = 'consolidate_memory_change'
      AND user_id = new.user_id
      AND namespace = COALESCE(
        (
          SELECT namespace
          FROM memory_items
          WHERE id = new.memory_item_id
        ),
        'personal'
      )
      AND status IN ('pending', 'failed')
      AND json_extract(payload_json, '$.memoryId') = new.memory_item_id;

    INSERT INTO memory_jobs (
      id,
      job_type,
      user_id,
      namespace,
      payload_json,
      priority,
      max_attempts,
      available_at,
      created_at,
      updated_at
    ) VALUES (
      'consolidate-change:' || new.id,
      'consolidate_memory_change',
      new.user_id,
      COALESCE(
        (
          SELECT namespace
          FROM memory_items
          WHERE id = new.memory_item_id
        ),
        'personal'
      ),
      json_object(
        'memoryId',
        new.memory_item_id,
        'eventId',
        new.id,
        'eventType',
        new.event_type
      ),
      4,
      5,
      new.created_at,
      new.created_at,
      new.created_at
    )
    ON CONFLICT(id) DO NOTHING;
  END;
`;

export const V37_MEMORY_EVIDENCE_TURN_INDEX = `
  CREATE INDEX IF NOT EXISTS memory_evidence_turn_version_idx
  ON memory_evidence(turn_id, memory_version_id)
`;

export const V39_MEMORY_EVIDENCE_TRIGGERS = [
  {
    name: 'memory_evidence_owner_insert',
    table: 'memory_evidence',
    sql: `
      CREATE TRIGGER memory_evidence_owner_insert
      BEFORE INSERT ON memory_evidence
      WHEN NEW.turn_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM memory_versions v
          JOIN memory_items i ON i.id = v.memory_item_id
          JOIN memories m ON m.id = i.id
          JOIN conversation_turns t ON t.id = NEW.turn_id
          JOIN conversation_sessions s ON s.id = t.session_id
          WHERE v.id = NEW.memory_version_id
            AND m.user_id = i.user_id
            AND m.namespace = i.namespace
            AND t.user_id = i.user_id
            AND t.namespace = i.namespace
            AND s.user_id = i.user_id
            AND s.namespace = i.namespace
            AND (
              (v.scope_type = 'personal' AND v.scope_key = 'self')
              OR (v.scope_type = 'role' AND s.persona_id = v.scope_key)
              OR (v.scope_type = 'project' AND s.project_id = v.scope_key)
              OR (v.scope_type = 'session' AND s.external_id = v.scope_key)
            )
        )
      BEGIN
        SELECT RAISE(ABORT, 'memory evidence owner/scope mismatch');
      END;
    `,
  },
  {
    name: 'memory_evidence_identity_update',
    table: 'memory_evidence',
    sql: `
      CREATE TRIGGER memory_evidence_identity_update
      BEFORE UPDATE OF memory_version_id, turn_id ON memory_evidence
      WHEN OLD.memory_version_id IS NOT NEW.memory_version_id
        OR (
          OLD.turn_id IS NOT NEW.turn_id
          AND NOT (
            OLD.turn_id IS NOT NULL
            AND NEW.turn_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM conversation_turns
              WHERE id = OLD.turn_id
            )
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'memory evidence identity is immutable');
      END;
    `,
  },
] as const;

export function normalizeSchemaSql(sql: string): string {
  return sql
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .replace(/;$/u, '')
    .toLowerCase();
}

export function physicalPurgeActionPredicate(row: 'OLD' | 'NEW'): string {
  return `
    ${row}.turn_id IS NULL
    AND ${row}.status IN ('completed', 'rejected')
    AND ${row}.target_query = '[purged]'
    AND ${row}.target_memory_id IS NULL
    AND ${row}.candidate_id IS NULL
    AND ${row}.candidate_json IS NULL
    AND ${row}.rationale = 'physical_purge'
    AND ${row}.error IS NULL
    AND ${row}.review_token IS NULL
    AND ${row}.review_claimed_at IS NULL
  `;
}

export const V26_IDENTITY_IMMUTABILITY_TRIGGERS = [
  {
    name: 'conversation_sessions_identity_immutable',
    table: 'conversation_sessions',
    sql: `
      CREATE TRIGGER conversation_sessions_identity_immutable
      BEFORE UPDATE OF
        user_id,
        namespace,
        client_name,
        external_id,
        persona_id,
        project_id,
        identity_source,
        identity_status
      ON conversation_sessions
      WHEN OLD.user_id IS NOT NEW.user_id
        OR OLD.namespace IS NOT NEW.namespace
        OR OLD.client_name IS NOT NEW.client_name
        OR OLD.external_id IS NOT NEW.external_id
        OR OLD.persona_id IS NOT NEW.persona_id
        OR OLD.project_id IS NOT NEW.project_id
        OR OLD.identity_source IS NOT NEW.identity_source
        OR OLD.identity_status IS NOT NEW.identity_status
      BEGIN
        SELECT RAISE(
          ABORT,
          'conversation session identity is immutable'
        );
      END;
    `,
  },
  {
    name: 'conversation_turns_identity_immutable',
    table: 'conversation_turns',
    sql: `
      CREATE TRIGGER conversation_turns_identity_immutable
      BEFORE UPDATE OF
        session_id,
        user_id,
        namespace,
        external_id,
        role
      ON conversation_turns
      WHEN OLD.session_id IS NOT NEW.session_id
        OR OLD.user_id IS NOT NEW.user_id
        OR OLD.namespace IS NOT NEW.namespace
        OR OLD.external_id IS NOT NEW.external_id
        OR OLD.role IS NOT NEW.role
      BEGIN
        SELECT RAISE(
          ABORT,
          'conversation turn identity is immutable'
        );
      END;
    `,
  },
  {
    name: 'memory_action_requests_identity_immutable',
    table: 'memory_action_requests',
    sql: `
      CREATE TRIGGER memory_action_requests_identity_immutable
      BEFORE UPDATE OF user_id, namespace, request_key, action
      ON memory_action_requests
      WHEN OLD.user_id IS NOT NEW.user_id
        OR OLD.namespace IS NOT NEW.namespace
        OR OLD.request_key IS NOT NEW.request_key
        OR OLD.action IS NOT NEW.action
      BEGIN
        SELECT RAISE(
          ABORT,
          'memory action request identity is immutable'
        );
      END;
    `,
  },
  {
    name: 'memory_action_requests_turn_binding_immutable',
    table: 'memory_action_requests',
    sql: `
      CREATE TRIGGER memory_action_requests_turn_binding_immutable
      BEFORE UPDATE ON memory_action_requests
      WHEN (
        OLD.turn_id IS NOT NULL
        AND OLD.turn_id IS NOT NEW.turn_id
        AND NOT (${physicalPurgeActionPredicate('NEW')})
      ) OR (
        ${physicalPurgeActionPredicate('OLD')}
        AND NOT (${physicalPurgeActionPredicate('NEW')})
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'memory action request turn binding is immutable'
        );
      END;
    `,
  },
] as const;

export const V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY =
  'v26-project-binding-and-identity-immutability-v2';
export const V26_IDENTITY_IMMUTABILITY_SCHEMA_FINGERPRINT = createHash(
  'sha256',
)
  .update(
    [
      V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY,
      V26_PROJECT_BINDING_SCHEMA_FINGERPRINT_V1,
      ...V26_IDENTITY_IMMUTABILITY_TRIGGERS.map(
        (trigger) =>
          `${trigger.name}\0${trigger.table}\0${normalizeSchemaSql(trigger.sql)}`,
      ),
    ].join('\n'),
  )
  .digest('hex');

export const V31_REFLECTION_TRIGGERS = [
  {
    name: 'conversation_turn_ingest_order_insert',
    table: 'conversation_turns',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_turn_ingest_order_insert
      AFTER INSERT ON conversation_turns
      BEGIN
        INSERT OR IGNORE INTO memory_turn_ingest_order (
          turn_id, session_id, user_id, namespace, ingested_at
        ) VALUES (
          NEW.id, NEW.session_id, NEW.user_id, NEW.namespace, NEW.created_at
        );
      END;
    `,
  },
  {
    name: 'memory_turn_ingest_order_owner_insert',
    table: 'memory_turn_ingest_order',
    sql: `
      CREATE TRIGGER IF NOT EXISTS memory_turn_ingest_order_owner_insert
      BEFORE INSERT ON memory_turn_ingest_order
      WHEN NOT EXISTS (
        SELECT 1
        FROM conversation_turns t
        JOIN conversation_sessions s ON s.id = t.session_id
        WHERE t.id = NEW.turn_id
          AND t.session_id = NEW.session_id
          AND t.user_id = NEW.user_id
          AND t.namespace = NEW.namespace
          AND s.id = NEW.session_id
          AND s.user_id = NEW.user_id
          AND s.namespace = NEW.namespace
      )
      BEGIN
        SELECT RAISE(ABORT, 'turn ingest owner/session mismatch');
      END;
    `,
  },
  {
    name: 'memory_turn_ingest_order_identity_immutable',
    table: 'memory_turn_ingest_order',
    sql: `
      CREATE TRIGGER IF NOT EXISTS memory_turn_ingest_order_identity_immutable
      BEFORE UPDATE OF turn_id, session_id, user_id, namespace
      ON memory_turn_ingest_order
      BEGIN
        SELECT RAISE(ABORT, 'turn ingest identity is immutable');
      END;
    `,
  },
  {
    name: 'memory_candidate_evidence_owner_insert',
    table: 'memory_candidate_evidence',
    sql: `
      CREATE TRIGGER IF NOT EXISTS memory_candidate_evidence_owner_insert
      BEFORE INSERT ON memory_candidate_evidence
      WHEN NOT EXISTS (
        SELECT 1
        FROM memory_candidates c
        JOIN conversation_turns t ON t.id = NEW.turn_id
        JOIN conversation_sessions s ON s.id = t.session_id
        WHERE c.id = NEW.candidate_id
          AND c.user_id = NEW.user_id
          AND c.namespace = NEW.namespace
          AND c.scope_type = NEW.scope_type
          AND c.scope_key = NEW.scope_key
          AND t.user_id = c.user_id
          AND t.namespace = c.namespace
          AND s.user_id = c.user_id
          AND s.namespace = c.namespace
          AND (
            (c.scope_type = 'personal' AND c.scope_key = 'self')
            OR (c.scope_type = 'role' AND s.persona_id = c.scope_key)
            OR (c.scope_type = 'project' AND s.project_id = c.scope_key)
            OR (c.scope_type = 'session' AND s.external_id = c.scope_key)
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'candidate evidence owner/scope mismatch');
      END;
    `,
  },
  {
    name: 'memory_candidate_evidence_owner_update',
    table: 'memory_candidate_evidence',
    sql: `
      CREATE TRIGGER IF NOT EXISTS memory_candidate_evidence_owner_update
      BEFORE UPDATE OF
        candidate_id, turn_id, user_id, namespace, scope_type, scope_key
      ON memory_candidate_evidence
      BEGIN
        SELECT RAISE(ABORT, 'candidate evidence identity is immutable');
      END;
    `,
  },
] as const;

export const V32_CONVERSATION_TRIGGERS = [
  {
    name: 'conversation_project_bindings_identity_immutable',
    table: 'conversation_project_bindings',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_project_bindings_identity_immutable
      BEFORE UPDATE OF principal_id, namespace, external_project_id
      ON conversation_project_bindings
      BEGIN
        SELECT RAISE(ABORT, 'conversation project identity is immutable');
      END;
    `,
  },
  {
    name: 'persona_chat_profiles_owner_insert',
    table: 'persona_chat_profiles',
    sql: `
      CREATE TRIGGER IF NOT EXISTS persona_chat_profiles_owner_insert
      BEFORE INSERT ON persona_chat_profiles
      WHEN NOT EXISTS (
        SELECT 1
        FROM client_persona_bindings b
        WHERE b.principal_id = NEW.principal_id
          AND b.persona_id = NEW.persona_id
          AND b.status = 'active'
      )
      BEGIN
        SELECT RAISE(ABORT, 'persona profile owner mismatch');
      END;
    `,
  },
  {
    name: 'persona_chat_profiles_immutable_update',
    table: 'persona_chat_profiles',
    sql: `
      CREATE TRIGGER IF NOT EXISTS persona_chat_profiles_immutable_update
      BEFORE UPDATE ON persona_chat_profiles
      BEGIN
        SELECT RAISE(ABORT, 'persona profile snapshot is immutable');
      END;
    `,
  },
  {
    name: 'persona_chat_profiles_immutable_delete',
    table: 'persona_chat_profiles',
    sql: `
      CREATE TRIGGER IF NOT EXISTS persona_chat_profiles_immutable_delete
      BEFORE DELETE ON persona_chat_profiles
      BEGIN
        SELECT RAISE(ABORT, 'persona profile snapshot is immutable');
      END;
    `,
  },
  {
    name: 'conversation_sessions_profile_snapshot_insert',
    table: 'conversation_sessions',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_sessions_profile_snapshot_insert
      BEFORE INSERT ON conversation_sessions
      WHEN NEW.persona_profile_version IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM persona_chat_profiles p
          WHERE p.principal_id = NEW.user_id
            AND p.persona_id = NEW.persona_id
            AND p.profile_version = NEW.persona_profile_version
        )
      BEGIN
        SELECT RAISE(ABORT, 'conversation profile snapshot mismatch');
      END;
    `,
  },
  {
    name: 'conversation_sessions_profile_snapshot_immutable',
    table: 'conversation_sessions',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_sessions_profile_snapshot_immutable
      BEFORE UPDATE OF persona_profile_version
      ON conversation_sessions
      WHEN NEW.persona_profile_version IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM persona_chat_profiles p
          WHERE p.principal_id = NEW.user_id
            AND p.persona_id = NEW.persona_id
            AND p.profile_version = NEW.persona_profile_version
        )
      BEGIN
        SELECT RAISE(ABORT, 'conversation profile snapshot mismatch');
      END;
    `,
  },
  {
    name: 'conversation_sessions_product_defaults_insert',
    table: 'conversation_sessions',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_sessions_product_defaults_insert
      AFTER INSERT ON conversation_sessions
      WHEN NEW.updated_at = ''
      BEGIN
        UPDATE conversation_sessions
        SET updated_at = NEW.started_at
        WHERE id = NEW.id;
      END;
    `,
  },
  {
    name: 'conversation_turns_product_defaults_insert',
    table: 'conversation_turns',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_turns_product_defaults_insert
      AFTER INSERT ON conversation_turns
      WHEN NEW.message_sequence IS NULL
        OR NEW.display_content IS NULL
        OR NEW.client_message_id IS NULL
        OR NEW.message_payload_hash IS NULL
        OR NEW.completed_at IS NULL
      BEGIN
        UPDATE conversation_turns
        SET
          message_sequence = COALESCE(
            NEW.message_sequence,
            (
              SELECT COALESCE(MAX(t.message_sequence), 0) + 1
              FROM conversation_turns t
              WHERE t.session_id = NEW.session_id
                AND t.id != NEW.id
            )
          ),
          display_content = COALESCE(NEW.display_content, NEW.content),
          client_message_id = COALESCE(
            NEW.client_message_id, NEW.external_id
          ),
          message_payload_hash = COALESCE(
            NEW.message_payload_hash, NEW.content_hash
          ),
          completed_at = COALESCE(NEW.completed_at, NEW.created_at)
        WHERE id = NEW.id;
      END;
    `,
  },
  {
    name: 'conversation_turns_product_rollup_insert',
    table: 'conversation_turns',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_turns_product_rollup_insert
      AFTER INSERT ON conversation_turns
      BEGIN
        UPDATE conversation_sessions
        SET
          message_count = message_count + 1,
          last_message_at = NEW.occurred_at,
          last_message_preview = SUBSTR(
            COALESCE(NEW.display_content, NEW.content), 1, 160
          ),
          updated_at = NEW.created_at,
          version = version + 1
        WHERE id = NEW.session_id;
      END;
    `,
  },
  {
    name: 'conversation_turns_assistant_protocol_guard_insert',
    table: 'conversation_turns',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_turns_assistant_protocol_guard_insert
      BEFORE INSERT ON conversation_turns
      WHEN NEW.role = 'assistant'
        AND (
          INSTR(NEW.content, '<|') > 0
          OR INSTR(NEW.content, '|>') > 0
          OR INSTR(LOWER(NEW.content), '<tool_call') > 0
          OR INSTR(LOWER(NEW.content), '<tool_result') > 0
          OR INSTR(
            NEW.content, '[Memory Bridge 自动长期记忆上下文]'
          ) > 0
          OR INSTR(NEW.content, '_memoryContext') > 0
          OR INSTR(COALESCE(NEW.display_content, ''), '<|') > 0
          OR INSTR(COALESCE(NEW.display_content, ''), '|>') > 0
          OR INSTR(
            LOWER(COALESCE(NEW.display_content, '')), '<tool_call'
          ) > 0
          OR INSTR(
            LOWER(COALESCE(NEW.display_content, '')), '<tool_result'
          ) > 0
          OR INSTR(
            COALESCE(NEW.display_content, ''),
            '[Memory Bridge 自动长期记忆上下文]'
          ) > 0
          OR INSTR(COALESCE(NEW.display_content, ''), '_memoryContext') > 0
        )
      BEGIN
        SELECT RAISE(ABORT, 'assistant protocol must be sanitized');
      END;
    `,
  },
  {
    name: 'conversation_turns_assistant_protocol_guard_update',
    table: 'conversation_turns',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_turns_assistant_protocol_guard_update
      BEFORE UPDATE OF role, content, display_content
      ON conversation_turns
      WHEN NEW.role = 'assistant'
        AND (
          INSTR(NEW.content, '<|') > 0
          OR INSTR(NEW.content, '|>') > 0
          OR INSTR(LOWER(NEW.content), '<tool_call') > 0
          OR INSTR(LOWER(NEW.content), '<tool_result') > 0
          OR INSTR(
            NEW.content, '[Memory Bridge 自动长期记忆上下文]'
          ) > 0
          OR INSTR(NEW.content, '_memoryContext') > 0
          OR INSTR(COALESCE(NEW.display_content, ''), '<|') > 0
          OR INSTR(COALESCE(NEW.display_content, ''), '|>') > 0
          OR INSTR(
            LOWER(COALESCE(NEW.display_content, '')), '<tool_call'
          ) > 0
          OR INSTR(
            LOWER(COALESCE(NEW.display_content, '')), '<tool_result'
          ) > 0
          OR INSTR(
            COALESCE(NEW.display_content, ''),
            '[Memory Bridge 自动长期记忆上下文]'
          ) > 0
          OR INSTR(COALESCE(NEW.display_content, ''), '_memoryContext') > 0
        )
      BEGIN
        SELECT RAISE(ABORT, 'assistant protocol must be sanitized');
      END;
    `,
  },
] as const;

export const V33_CONVERSATION_ROUND_TRIGGERS = [
  {
    name: 'conversation_rounds_scope_insert',
    table: 'conversation_rounds',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_rounds_scope_insert
      BEFORE INSERT ON conversation_rounds
      WHEN NOT EXISTS (
        SELECT 1
        FROM conversation_sessions s
        JOIN conversation_turns t ON t.id = NEW.user_message_id
        WHERE s.id = NEW.conversation_id
          AND s.user_id = NEW.user_id
          AND s.namespace = NEW.namespace
          AND s.status != 'deleted'
          AND t.session_id = s.id
          AND t.user_id = s.user_id
          AND t.namespace = s.namespace
          AND t.role = 'user'
          AND t.round_id = NEW.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'conversation round owner mismatch');
      END;
    `,
  },
  {
    name: 'conversation_rounds_identity_update',
    table: 'conversation_rounds',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_rounds_identity_update
      BEFORE UPDATE OF
        id, conversation_id, user_id, namespace, client_message_id,
        request_payload_hash, user_message_id, persona_profile_version_used
      ON conversation_rounds
      BEGIN
        SELECT RAISE(ABORT, 'conversation round identity is immutable');
      END;
    `,
  },
  {
    name: 'conversation_rounds_assistant_update',
    table: 'conversation_rounds',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_rounds_assistant_update
      BEFORE UPDATE OF active_assistant_message_id
      ON conversation_rounds
      WHEN NEW.active_assistant_message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM conversation_turns t
          WHERE t.id = NEW.active_assistant_message_id
            AND t.session_id = NEW.conversation_id
            AND t.user_id = NEW.user_id
            AND t.namespace = NEW.namespace
            AND t.role = 'assistant'
            AND t.round_id = NEW.id
        )
      BEGIN
        SELECT RAISE(ABORT, 'conversation round assistant mismatch');
      END;
    `,
  },
  {
    name: 'conversation_round_attempts_scope_insert',
    table: 'conversation_round_attempts',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_round_attempts_scope_insert
      BEFORE INSERT ON conversation_round_attempts
      WHEN NOT EXISTS (
        SELECT 1
        FROM conversation_rounds r
        WHERE r.id = NEW.round_id
          AND r.generation = NEW.generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'conversation round attempt mismatch');
      END;
    `,
  },
  {
    name: 'conversation_round_events_scope_insert',
    table: 'conversation_round_events',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_round_events_scope_insert
      BEFORE INSERT ON conversation_round_events
      WHEN NEW.event_id != NEW.round_id || ':' || NEW.sequence
        OR NOT EXISTS (
          SELECT 1
          FROM conversation_rounds r
          WHERE r.id = NEW.round_id
        )
        OR (
          NEW.attempt_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM conversation_round_attempts a
            WHERE a.id = NEW.attempt_id
              AND a.round_id = NEW.round_id
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'conversation round event mismatch');
      END;
    `,
  },
] as const;

export const V35_CONVERSATION_REGENERATION_TRIGGERS = [
  {
    name: 'conversation_regeneration_requests_scope_insert',
    table: 'conversation_regeneration_requests',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_regeneration_requests_scope_insert
      BEFORE INSERT ON conversation_regeneration_requests
      WHEN NOT EXISTS (
        SELECT 1
        FROM conversation_rounds r
        JOIN conversation_turns source
          ON source.id = NEW.source_assistant_message_id
        JOIN conversation_round_attempts attempt
          ON attempt.id = NEW.attempt_id
        WHERE r.id = NEW.round_id
          AND r.conversation_id = NEW.conversation_id
          AND r.user_id = NEW.user_id
          AND r.namespace = NEW.namespace
          AND r.active_assistant_message_id = source.id
          AND source.session_id = r.conversation_id
          AND source.user_id = r.user_id
          AND source.namespace = r.namespace
          AND source.round_id = r.id
          AND source.role = 'assistant'
          AND source.message_status = 'completed'
          AND source.is_active_variant = 1
          AND attempt.round_id = r.id
          AND attempt.attempt_type = 'regenerate'
          AND attempt.generation = r.generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'conversation regeneration scope mismatch');
      END;
    `,
  },
  {
    name: 'conversation_regeneration_requests_identity_update',
    table: 'conversation_regeneration_requests',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_regeneration_requests_identity_update
      BEFORE UPDATE OF
        id, user_id, namespace, conversation_id, round_id,
        client_request_id, source_assistant_message_id,
        request_payload_hash, attempt_id
      ON conversation_regeneration_requests
      BEGIN
        SELECT RAISE(ABORT, 'conversation regeneration identity is immutable');
      END;
    `,
  },
] as const;

export const V36_CONVERSATION_DELETION_TRIGGERS = [
  {
    name: 'conversation_sessions_deleted_terminal',
    table: 'conversation_sessions',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_sessions_deleted_terminal
      BEFORE UPDATE OF status ON conversation_sessions
      WHEN OLD.status = 'deleted' AND NEW.status != 'deleted'
      BEGIN
        SELECT RAISE(ABORT, 'deleted conversation cannot be restored');
      END;
    `,
  },
  {
    name: 'conversation_turns_deleted_session_insert',
    table: 'conversation_turns',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_turns_deleted_session_insert
      BEFORE INSERT ON conversation_turns
      WHEN EXISTS (
        SELECT 1 FROM conversation_sessions s
        WHERE s.id = NEW.session_id AND s.status = 'deleted'
      )
      BEGIN
        SELECT RAISE(ABORT, 'deleted conversation rejects new messages');
      END;
    `,
  },
  {
    name: 'conversation_deletion_receipts_identity_update',
    table: 'conversation_deletion_receipts',
    sql: `
      CREATE TRIGGER IF NOT EXISTS
      conversation_deletion_receipts_identity_update
      BEFORE UPDATE OF
        id, user_id, namespace, client_request_id, resource_type,
        resource_id, conversation_id, memory_policy, reason_hash,
        request_payload_hash
      ON conversation_deletion_receipts
      BEGIN
        SELECT RAISE(ABORT, 'conversation deletion identity is immutable');
      END;
    `,
  },
  {
    name: 'conversation_import_states_identity_update',
    table: 'conversation_import_states',
    sql: `
      CREATE TRIGGER IF NOT EXISTS conversation_import_states_identity_update
      BEFORE UPDATE OF user_id, namespace, import_id, lane
      ON conversation_import_states
      BEGIN
        SELECT RAISE(ABORT, 'conversation import identity is immutable');
      END;
    `,
  },
] as const;
