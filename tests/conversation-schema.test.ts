import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  openDatabase,
  SCHEMA_VERSION,
} from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ROUND_ONE_ID = '44444444-4444-4444-8444-444444444444';
const ROUND_TWO_ID = '55555555-5555-4555-8555-555555555555';

function tableColumns(
  database: DatabaseSync,
  table: string,
): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => String(column.name)),
  );
}

function removeV32Structure(database: DatabaseSync): void {
  for (const trigger of [
    'conversation_sessions_deleted_terminal',
    'conversation_turns_deleted_session_insert',
    'conversation_deletion_receipts_identity_update',
    'conversation_import_states_identity_update',
  ]) {
    database.exec(`DROP TRIGGER IF EXISTS "${trigger}";`);
  }
  for (const index of [
    'conversation_deletion_receipts_owner_idx',
    'conversation_deletion_barriers_expiry_idx',
    'conversation_memory_recompute_status_idx',
    'conversation_maintenance_jobs_ready_idx',
    'conversation_import_receipts_owner_idx',
    'conversation_import_messages_round_idx',
  ]) {
    database.exec(`DROP INDEX IF EXISTS "${index}";`);
  }
  for (const table of [
    'conversation_import_messages',
    'conversation_import_sessions',
    'conversation_import_receipts',
    'conversation_import_states',
    'conversation_maintenance_jobs',
    'conversation_memory_recomputations',
    'conversation_deleted_evidence_proofs',
    'conversation_deletion_barriers',
    'conversation_deletion_receipts',
  ]) {
    database.exec(`DROP TABLE IF EXISTS "${table}";`);
  }
  database.exec('DROP INDEX IF EXISTS conversation_regeneration_request_idx;');
  database.exec('DROP INDEX IF EXISTS conversation_turns_generation_active_idx;');
  database.exec('DROP INDEX IF EXISTS conversation_turns_generation_variant_idx;');
  database.exec('DROP INDEX IF EXISTS conversation_turns_round_user_idx;');
  database.exec('DROP TABLE IF EXISTS conversation_regeneration_requests;');
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_turns_round_role_idx
      ON conversation_turns(session_id, round_id, role)
      WHERE round_id IS NOT NULL;
  `);
  database.exec('DROP INDEX IF EXISTS conversation_changes_owner_sequence_idx;');
  database.exec('DROP INDEX IF EXISTS conversation_changes_expiry_idx;');
  database.exec('DROP TABLE IF EXISTS conversation_changes;');
  for (const trigger of [
    'conversation_rounds_scope_insert',
    'conversation_rounds_identity_update',
    'conversation_rounds_assistant_update',
    'conversation_round_attempts_scope_insert',
    'conversation_round_events_scope_insert',
  ]) {
    database.exec(`DROP TRIGGER IF EXISTS "${trigger}";`);
  }
  for (const index of [
    'conversation_rounds_client_message_idx',
    'conversation_rounds_single_flight_idx',
    'conversation_rounds_tenant_idx',
    'conversation_round_attempts_number_idx',
    'conversation_round_attempts_lease_idx',
    'conversation_round_events_sequence_idx',
    'conversation_round_events_expiry_idx',
  ]) {
    database.exec(`DROP INDEX IF EXISTS "${index}";`);
  }
  database.exec('DROP TABLE IF EXISTS conversation_round_events;');
  database.exec('DROP TABLE IF EXISTS conversation_round_attempts;');
  database.exec('DROP TABLE IF EXISTS conversation_rounds;');

  for (const trigger of [
    'persona_chat_profiles_owner_insert',
    'persona_chat_profiles_immutable_update',
    'persona_chat_profiles_immutable_delete',
    'conversation_sessions_profile_snapshot_insert',
    'conversation_sessions_profile_snapshot_immutable',
    'conversation_sessions_product_defaults_insert',
    'conversation_turns_product_defaults_insert',
    'conversation_turns_product_rollup_insert',
    'conversation_turns_assistant_protocol_guard_insert',
    'conversation_turns_assistant_protocol_guard_update',
    'conversation_project_bindings_identity_immutable',
  ]) {
    database.exec(`DROP TRIGGER IF EXISTS "${trigger}";`);
  }
  for (const index of [
    'persona_chat_profiles_current_idx',
    'conversation_sessions_create_idempotency_idx',
    'conversation_sessions_product_list_idx',
    'conversation_turns_message_sequence_idx',
    'conversation_turns_client_message_idx',
    'conversation_message_actions_message_idx',
    'conversation_cursor_keys_one_current_idx',
    'conversation_project_bindings_list_idx',
  ]) {
    database.exec(`DROP INDEX IF EXISTS "${index}";`);
  }
  database.exec('DROP TABLE IF EXISTS conversation_message_actions;');
  database.exec('DROP TABLE IF EXISTS persona_chat_profiles;');
  database.exec('DROP TABLE IF EXISTS conversation_cursor_keys;');
  database.exec('DROP TABLE IF EXISTS conversation_project_bindings;');

  const sessionColumns = tableColumns(database, 'conversation_sessions');
  for (const column of [
    'title',
    'status',
    'version',
    'last_message_at',
    'last_message_preview',
    'message_count',
    'persona_profile_version',
    'updated_at',
    'create_idempotency_key',
    'create_payload_hash',
    'deletion_generation',
    'deleted_at',
  ]) {
    if (sessionColumns.has(column)) {
      database.exec(`ALTER TABLE conversation_sessions DROP COLUMN "${column}";`);
    }
  }
  const turnColumns = tableColumns(database, 'conversation_turns');
  for (const column of [
    'message_sequence',
    'display_content',
    'normalized_content',
    'message_status',
    'client_message_id',
    'message_payload_hash',
    'generation_group_id',
    'variant_index',
    'is_active_variant',
    'completed_at',
    'message_version',
  ]) {
    if (turnColumns.has(column)) {
      database.exec(`ALTER TABLE conversation_turns DROP COLUMN "${column}";`);
    }
  }
  database.exec('PRAGMA user_version = 31;');
}

test(`当前 schema ${SCHEMA_VERSION} 从空库建立会话、删除、导入与生成变体约束`, () => {
  const database = openDatabase(':memory:');
  try {
    assert.equal(
      Number(database.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    const sessionColumns = tableColumns(database, 'conversation_sessions');
    for (const column of [
      'title',
      'status',
      'version',
      'last_message_at',
      'last_message_preview',
      'message_count',
      'persona_profile_version',
      'updated_at',
      'create_idempotency_key',
      'create_payload_hash',
      'deletion_generation',
      'deleted_at',
    ]) {
      assert.equal(sessionColumns.has(column), true, column);
    }
    const turnColumns = tableColumns(database, 'conversation_turns');
    for (const column of [
      'message_sequence',
      'display_content',
      'normalized_content',
      'message_status',
      'client_message_id',
      'message_payload_hash',
      'generation_group_id',
      'variant_index',
      'is_active_variant',
      'completed_at',
      'message_version',
    ]) {
      assert.equal(turnColumns.has(column), true, column);
    }
    const tables = new Set(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'`,
        )
        .all()
        .map((row) => String(row.name)),
    );
    assert.equal(tables.has('persona_chat_profiles'), true);
    assert.equal(tables.has('conversation_message_actions'), true);
    assert.equal(tables.has('conversation_cursor_keys'), true);
    assert.equal(tables.has('conversation_project_bindings'), true);
    assert.equal(tables.has('conversation_rounds'), true);
    assert.equal(tables.has('conversation_round_attempts'), true);
    assert.equal(tables.has('conversation_round_events'), true);
    assert.equal(tables.has('conversation_changes'), true);
    assert.equal(tables.has('conversation_regeneration_requests'), true);
    for (const table of [
      'conversation_deletion_receipts',
      'conversation_deletion_barriers',
      'conversation_deleted_evidence_proofs',
      'conversation_memory_recomputations',
      'conversation_maintenance_jobs',
      'conversation_import_states',
      'conversation_import_receipts',
      'conversation_import_sessions',
      'conversation_import_messages',
      'conversation_episode_compactions',
    ]) {
      assert.equal(tables.has(table), true, table);
    }
    const indexes = new Set(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'`,
        )
        .all()
        .map((row) => String(row.name)),
    );
    assert.equal(indexes.has('conversation_turns_round_role_idx'), false);
    assert.equal(indexes.has('conversation_turns_round_user_idx'), true);
    assert.equal(indexes.has('conversation_turns_generation_variant_idx'), true);
    assert.equal(indexes.has('conversation_turns_generation_active_idx'), true);
    for (const index of [
      'conversation_deletion_receipts_owner_idx',
      'conversation_deletion_barriers_expiry_idx',
      'conversation_memory_recompute_status_idx',
      'conversation_maintenance_jobs_ready_idx',
      'conversation_import_receipts_owner_idx',
      'conversation_import_messages_round_idx',
      'conversation_episode_compactions_owner_idx',
    ]) {
      assert.equal(indexes.has(index), true, index);
    }
    const projectColumns = tableColumns(
      database,
      'conversation_project_bindings',
    );
    for (const column of [
      'display_name',
      'status',
      'version',
      'created_at',
      'updated_at',
      'last_seen_at',
    ]) {
      assert.equal(projectColumns.has(column), true, column);
    }
  } finally {
    database.close();
  }
});

test('schema 31 增量升级保留历史并保持 LifecycleStore round/身份语义', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-conversation-v31-'),
  );
  const filePath = path.join(directory, 'memory.sqlite3');
  try {
    const initial = openDatabase(filePath);
    initial
      .prepare(
        `INSERT OR IGNORE INTO account_principals (
           id, display_name, status, created_at, updated_at
         ) VALUES ('alice', 'Alice', 'active', ?, ?)`,
      )
      .run(
        '2026-08-12T00:00:00.000Z',
        '2026-08-12T00:00:00.000Z',
      );
    const identity = new IdentityService(initial);
    identity.bindPersona(identity.trustPrincipal('alice'), {
      clientType: 'airi',
      clientInstanceId: 'migration-desktop',
      personaId: PERSONA_ID,
      displayName: '迁移角色',
    });
    const lifecycle = new LifecycleStore(
      initial,
      () => new Date('2026-08-12T00:00:00.000Z'),
    );
    lifecycle.recordTurn({
      userId: 'alice',
      namespace: 'chat',
      personaId: PERSONA_ID,
      projectId: PROJECT_ID,
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: ROUND_ONE_ID,
      clientName: 'client',
      sessionExternalId: SESSION_ID,
      turnExternalId: 'legacy-user-message',
      role: 'user',
      content: '迁移前消息',
    });
    initial.close();

    const v31 = new DatabaseSync(filePath);
    v31.exec('PRAGMA foreign_keys = ON;');
    removeV32Structure(v31);
    v31.close();

    const migrated = openDatabase(filePath);
    try {
      assert.equal(
        Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
        SCHEMA_VERSION,
      );
      const legacy = migrated
        .prepare(
          `SELECT message_sequence, display_content, message_status,
                  client_message_id
           FROM conversation_turns
           WHERE external_id = 'legacy-user-message'`,
        )
        .get();
      assert.deepEqual({ ...legacy }, {
        message_sequence: 1,
        display_content: '迁移前消息',
        message_status: 'completed',
        client_message_id: 'legacy-user-message',
      });
      const defaultProfile = migrated
        .prepare(
          `SELECT profile_version, display_name, system_prompt,
                  greeting, language, capability_ids_json
           FROM persona_chat_profiles
           WHERE principal_id = 'alice' AND persona_id = ?`,
        )
        .get(PERSONA_ID);
      assert.deepEqual({ ...defaultProfile }, {
        profile_version: 1,
        display_name: '迁移角色',
        system_prompt: '',
        greeting: '',
        language: 'zh-Hans',
        capability_ids_json: '[]',
      });
      assert.equal(
        migrated
          .prepare(
            `SELECT persona_profile_version
             FROM conversation_sessions WHERE external_id = ?`,
          )
          .get(SESSION_ID)?.persona_profile_version,
        1,
      );
      assert.deepEqual(
        {
          ...migrated
            .prepare(
              `SELECT principal_id, namespace, external_project_id,
                      display_name, status, version
               FROM conversation_project_bindings
               WHERE principal_id = 'alice'`,
            )
            .get(),
        },
        {
          principal_id: 'alice',
          namespace: 'chat',
          external_project_id: PROJECT_ID,
          display_name: PROJECT_ID,
          status: 'active',
          version: 1,
        },
      );

      const reopenedLifecycle = new LifecycleStore(
        migrated,
        () => new Date('2026-08-12T00:01:00.000Z'),
      );
      reopenedLifecycle.recordTurn({
        userId: 'alice',
        namespace: 'chat',
        personaId: PERSONA_ID,
        projectId: PROJECT_ID,
        identitySource: 'credential',
        identityStatus: 'complete',
        roundId: ROUND_TWO_ID,
        clientName: 'client',
        sessionExternalId: SESSION_ID,
        turnExternalId: 'post-migration-user-message',
        role: 'user',
        content: '迁移后消息',
      });
      assert.equal(
        migrated
          .prepare(
            `SELECT message_sequence FROM conversation_turns
             WHERE external_id = 'post-migration-user-message'`,
          )
          .get()?.message_sequence,
        2,
      );
      assert.throws(
        () =>
          migrated
            .prepare(
              `UPDATE conversation_sessions
               SET persona_id = ? WHERE external_id = ?`,
            )
            .run(
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              SESSION_ID,
            ),
        /identity is immutable/iu,
      );
      assert.throws(
        () =>
          reopenedLifecycle.recordTurn({
            userId: 'alice',
            namespace: 'chat',
            personaId: PERSONA_ID,
            projectId: PROJECT_ID,
            identitySource: 'credential',
            identityStatus: 'complete',
            roundId: ROUND_TWO_ID,
            clientName: 'client',
            sessionExternalId: SESSION_ID,
            turnExternalId: 'duplicate-round-user',
            role: 'user',
            content: '同一 round 的第二条 user',
          }),
        /UNIQUE constraint failed/iu,
      );
    } finally {
      migrated.close();
    }

    const backups = fs.readdirSync(
      path.join(directory, 'migration-backups'),
    );
    assert.equal(backups.length >= 1, true);
    const backup = new DatabaseSync(
      path.join(directory, 'migration-backups', backups.at(-1)!),
      { readOnly: true },
    );
    assert.equal(
      Number(backup.prepare('PRAGMA user_version').get()?.user_version),
      31,
    );
    backup.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
