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
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';

function insertDenseMigrationMemory(
  database: DatabaseSync,
  id: string,
  userId = 'default',
  namespace = 'personal',
): void {
  const timestamp = '2026-07-29T00:00:00.000Z';
  database
    .prepare(
      `INSERT INTO memories (
         id, user_id, namespace, kind, title, content, summary,
         tags_json, importance, confidence, status, source, source_ref,
         occurred_at, valid_from, valid_to, created_at, updated_at,
         last_seen_at, access_count, checksum, embedding
       ) VALUES (
         ?, ?, ?, 'knowledge', 'Dense migration', ?, '', '[]',
         0.5, 1, 'active', 'migration-test', NULL,
         NULL, NULL, NULL, ?, ?, ?, 0, ?, ?
       )`,
    )
    .run(
      id,
      userId,
      namespace,
      `Dense migration memory ${id}`,
      timestamp,
      timestamp,
      timestamp,
      'd'.repeat(64),
      new Uint8Array([0, 0, 0, 0]),
    );
}

function insertIdentityImmutabilityFixture(database: DatabaseSync): {
  sessionId: string;
  otherSessionId: string;
  turnId: string;
  otherTurnId: string;
  actionRequestId: string;
} {
  const timestamp = '2026-08-02T00:00:00.000Z';
  const insertSession = database.prepare(
    `INSERT INTO conversation_sessions (
       id, user_id, namespace, client_name, external_id,
       persona_id, project_id, identity_source, identity_status,
       started_at, metadata_json
     ) VALUES (?, 'default', 'personal', 'airi', ?, 'persona-A', ?,
       'credential', 'complete', ?, '{}')`,
  );
  insertSession.run('identity-session-A', 'external-session-A', 'project-A', timestamp);
  insertSession.run('identity-session-B', 'external-session-B', 'project-B', timestamp);

  const insertTurn = database.prepare(
    `INSERT INTO conversation_turns (
       id, session_id, user_id, namespace, external_id, role,
       content, content_hash, occurred_at, created_at, metadata_json
     ) VALUES (?, ?, 'default', 'personal', ?, 'user', ?, ?, ?, ?, '{}')`,
  );
  insertTurn.run(
    'identity-turn-A',
    'identity-session-A',
    'external-turn-A',
    'turn A',
    'identity-turn-hash-A',
    timestamp,
    timestamp,
  );
  insertTurn.run(
    'identity-turn-B',
    'identity-session-B',
    'external-turn-B',
    'turn B',
    'identity-turn-hash-B',
    timestamp,
    timestamp,
  );

  database
    .prepare(
      `INSERT INTO memory_action_requests (
         id, user_id, namespace, request_key, action, status,
         target_query, turn_id, model, prompt_version, rationale,
         created_at
       ) VALUES (
         'identity-action-A', 'default', 'personal',
         'identity-action-request-A', 'forget', 'pending',
         'project fact', NULL, 'migration-test', 'v1', '', ?
       )`,
    )
    .run(timestamp);

  return {
    sessionId: 'identity-session-A',
    otherSessionId: 'identity-session-B',
    turnId: 'identity-turn-A',
    otherTurnId: 'identity-turn-B',
    actionRequestId: 'identity-action-A',
  };
}

test('生产数据库启用 WAL、有界页缓存、mmap 和内存临时表', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-database-pragmas-'),
  );
  const database = openDatabase(path.join(directory, 'memory.sqlite3'));
  try {
    const cacheSize = Number(
      database.prepare('PRAGMA cache_size').get()?.cache_size,
    );
    const mmapSize = Number(
      database.prepare('PRAGMA mmap_size').get()?.mmap_size,
    );
    const tempStore = Number(
      database.prepare('PRAGMA temp_store').get()?.temp_store,
    );
    const journalMode = String(
      database.prepare('PRAGMA journal_mode').get()?.journal_mode,
    ).toLowerCase();
    assert.equal(journalMode, 'wal');
    assert.ok(cacheSize <= -65_536);
    assert.ok(mmapSize >= 268_435_456);
    assert.equal(tempStore, 2);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v2 审计记录迁移为用户内稳定 ID', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');

  try {
    openDatabase(filePath).close();
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      DROP INDEX memory_embeddings_model_idx;
      DROP TABLE memory_embeddings;
      DROP INDEX audit_created_idx;
      DROP INDEX audit_user_idx;
      DROP TABLE audit_log;

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        memory_id TEXT,
        user_id TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      INSERT INTO audit_log (
        id, action, memory_id, user_id, detail_json, created_at
      ) VALUES
        (1, 'remember', NULL, 'default', '{}', '2026-01-01T00:00:00.000Z'),
        (2, 'remember', NULL, 'bob', '{}', '2026-01-01T00:00:01.000Z');

      CREATE INDEX audit_created_idx
        ON audit_log(created_at DESC);
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    const embeddingTable = migrated
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = 'memory_embeddings'`,
      )
      .get();
    assert.equal(embeddingTable?.name, 'memory_embeddings');
    const lifecycleTables = migrated
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'conversation_sessions',
             'conversation_turns',
             'conversation_lineage_keys',
             'turn_tool_events',
             'memory_candidates',
             'memory_items',
             'memory_versions',
             'memory_dense_lsh',
             'embedding_model_registry',
             'dense_index_generations',
             'dense_index_aliases',
             'memory_evidence',
             'memory_events',
             'outbox_events',
             'memory_jobs',
             'memory_tombstones'
           )
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(lifecycleTables, [
      'conversation_lineage_keys',
      'conversation_sessions',
      'conversation_turns',
      'dense_index_aliases',
      'dense_index_generations',
      'embedding_model_registry',
      'memory_candidates',
      'memory_dense_lsh',
      'memory_events',
      'memory_evidence',
      'memory_items',
      'memory_jobs',
      'memory_tombstones',
      'memory_versions',
      'outbox_events',
      'turn_tool_events',
    ]);
    const outboxColumns = migrated
      .prepare('PRAGMA table_info(outbox_events)')
      .all()
      .map((row) => row.name);
    assert.ok(outboxColumns.includes('lease_owner'));
    assert.ok(outboxColumns.includes('max_attempts'));
    assert.ok(outboxColumns.includes('updated_at'));
    const jobColumns = migrated
      .prepare('PRAGMA table_info(memory_jobs)')
      .all()
      .map((row) => row.name);
    assert.ok(jobColumns.includes('required_model_id'));
    assert.ok(jobColumns.includes('required_generation_id'));
    migrated
      .prepare(
        `INSERT INTO audit_log (
           id, action, memory_id, user_id, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        'recall',
        null,
        'bob',
        '{}',
        '2026-01-01T00:00:02.000Z',
      );

    const rows = migrated
      .prepare(
        `SELECT id, user_id
         FROM audit_log
         ORDER BY user_id, id`,
      )
      .all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: 1, user_id: 'bob' },
      { id: 2, user_id: 'bob' },
      { id: 1, user_id: 'default' },
    ]);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v9 把既有记忆无损回填为版本化真相和混合索引', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v5-backfill-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');

  try {
    const database = openDatabase(filePath);
    database
      .prepare(
        `INSERT INTO memories (
           id, user_id, namespace, kind, title, content, summary,
           tags_json, importance, confidence, status, source, source_ref,
           occurred_at, valid_from, valid_to, created_at, updated_at,
           last_seen_at, access_count, checksum, embedding
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           0, ?, ?
         )`,
      )
      .run(
        '11111111-1111-4111-8111-111111111111',
        'default',
        'personal',
        'preference',
        '空数据偏好',
        '用户不喜欢应用内置演示数据。',
        '',
        '["产品"]',
        0.9,
        1,
        'active',
        'test',
        null,
        null,
        null,
        null,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        'a'.repeat(64),
        new Uint8Array([0, 0, 0, 0]),
      );
    database.exec('PRAGMA user_version = 4;');
    database.close();

    const migrated = openDatabase(filePath);
    const backupFiles = fs.readdirSync(
      path.join(directory, 'migration-backups'),
    );
    assert.equal(backupFiles.length, 1);
    const backup = new DatabaseSync(
      path.join(directory, 'migration-backups', backupFiles[0]),
      { readOnly: true },
    );
    assert.equal(
      Number(backup.prepare('PRAGMA user_version').get()?.user_version),
      4,
    );
    assert.equal(
      backup
        .prepare('SELECT content FROM memories WHERE id = ?')
        .get('11111111-1111-4111-8111-111111111111')?.content,
      '用户不喜欢应用内置演示数据。',
    );
    backup.close();
    const item = migrated
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get('11111111-1111-4111-8111-111111111111');
    assert.equal(
      item?.current_version_id,
      '11111111-1111-4111-8111-111111111111:v1',
    );
    assert.equal(item?.revision, 1);
    assert.equal(item?.predicate_key, 'legacy:11111111-1111-4111-8111-111111111111');
    assert.equal(item?.observation_count, 1);
    const version = migrated
      .prepare(
        `SELECT * FROM memory_versions
         WHERE memory_item_id = ? AND version = 1`,
      )
      .get('11111111-1111-4111-8111-111111111111');
    assert.equal(version?.content, '用户不喜欢应用内置演示数据。');
    assert.equal(version?.created_by, 'legacy-migration');
    assert.equal(
      migrated
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_events
           WHERE memory_item_id = ?`,
        )
        .get('11111111-1111-4111-8111-111111111111')?.count,
      1,
    );
    const fullText = migrated
      .prepare(
        `SELECT memory_id
         FROM memories_fts
         WHERE memories_fts MATCH '"不喜欢应用"'`,
      )
      .get();
    assert.equal(
      fullText?.memory_id,
      '11111111-1111-4111-8111-111111111111',
    );
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v12 会继续迁移 Dense 维度和指纹世代而不是提前返回', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v12-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    database.exec('PRAGMA user_version = 12;');
    database.exec('DROP TABLE dense_index_state;');
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    assert.ok(
      migrated
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name = 'dense_index_state'`,
        )
        .get(),
    );
    assert.ok(
      (
        migrated
          .prepare('PRAGMA table_info(memory_dense_lsh)')
          .all() as Array<Record<string, unknown>>
      ).some((column) => column.name === 'dimensions'),
    );
    for (const table of [
      'memory_embeddings',
      'memory_dense_lsh',
      'dense_index_state',
    ]) {
      assert.ok(
        (
          migrated
            .prepare(`PRAGMA table_info(${table})`)
            .all() as Array<Record<string, unknown>>
        ).some((column) => column.name === 'generation_key'),
      );
    }
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v13 会迁移 Dense 指纹和记忆修订世代字段', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v13-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    database.exec(`
      DROP INDEX IF EXISTS memory_dense_lsh_generation_key_idx;
      DROP INDEX IF EXISTS memory_dense_lsh_revision_idx;
      ALTER TABLE memory_embeddings
      DROP COLUMN generation_key;
      ALTER TABLE memory_dense_lsh
      DROP COLUMN generation_key;
      ALTER TABLE dense_index_state
      DROP COLUMN generation_key;
      PRAGMA user_version = 13;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    for (const table of [
      'memory_embeddings',
      'memory_dense_lsh',
      'dense_index_state',
    ]) {
      assert.ok(
        (
          migrated
            .prepare(`PRAGMA table_info(${table})`)
            .all() as Array<Record<string, unknown>>
        ).some((column) => column.name === 'generation_key'),
      );
    }
    assert.ok(
      (
        migrated
          .prepare('PRAGMA table_info(memories)')
          .all() as Array<Record<string, unknown>>
      ).some((column) => column.name === 'semantic_revision'),
    );
    for (const table of [
      'memory_embeddings',
      'memory_dense_lsh',
    ]) {
      assert.ok(
        (
          migrated
            .prepare(`PRAGMA table_info(${table})`)
            .all() as Array<Record<string, unknown>>
        ).some((column) => column.name === 'memory_revision'),
      );
    }
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v14 会迁移记忆语义修订并建立自动递增触发器', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v14-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    database.exec(`
      DROP TRIGGER memories_semantic_revision_au;
      DROP INDEX memory_embeddings_generation_idx;
      DROP INDEX IF EXISTS memory_dense_lsh_revision_idx;
      ALTER TABLE memory_embeddings
      DROP COLUMN memory_revision;
      ALTER TABLE memory_dense_lsh
      DROP COLUMN memory_revision;
      ALTER TABLE memories
      DROP COLUMN semantic_revision;
      PRAGMA user_version = 14;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    assert.ok(
      migrated
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'trigger'
             AND name = 'memories_semantic_revision_au'`,
        )
        .get(),
    );
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v15 会迁移作用域、权威来源和五路解析审计', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v15-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    database.exec(`
      DROP TABLE candidate_resolution_runs;
      PRAGMA user_version = 15;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    assert.ok(
      migrated
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name = 'candidate_resolution_runs'`,
        )
        .get(),
    );
    const candidateColumns = new Set(
      (
        migrated
          .prepare('PRAGMA table_info(memory_candidates)')
          .all() as Array<Record<string, unknown>>
      ).map((entry) => entry.name),
    );
    for (const column of [
      'negated',
      'scope_type',
      'scope_key',
      'claim_occurred_at',
      'claim_valid_from',
      'claim_valid_to',
      'source_excerpt',
      'source_authority',
      'extractor_id',
      'extractor_version',
      'extraction_model',
      'extraction_prompt_version',
    ]) {
      assert.ok(candidateColumns.has(column));
    }
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v16 会迁移提取器身份和候选稳定键', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v16-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    database.exec(`
      INSERT INTO conversation_sessions (
        id, user_id, namespace, client_name, external_id,
        started_at, metadata_json
      ) VALUES (
        'session-v16', 'default', 'personal', 'test', 'session-v16',
        '2026-07-29T00:00:00.000Z', '{}'
      );
      INSERT INTO conversation_turns (
        id, session_id, user_id, namespace, external_id, role,
        content, content_hash, occurred_at, created_at, metadata_json
      ) VALUES (
        'turn-v16', 'session-v16', 'default', 'personal', 'turn-v16',
        'user', '我使用 VS Code', 'hash',
        '2026-07-29T00:00:00.000Z',
        '2026-07-29T00:00:00.000Z', '{}'
      );
      INSERT INTO extraction_runs (
        id, turn_id, model, prompt_version, status, created_at
      ) VALUES (
        'run-v16', 'turn-v16', 'qwen2.5:14b', 'extract-v1',
        'completed', '2026-07-29T00:00:00.000Z'
      );
      INSERT INTO memory_candidates (
        id, user_id, namespace, turn_id, extraction_run_id, kind,
        subject, predicate, value_text, normalized_key, normalized_hash,
        content, confidence, importance, sensitivity, state,
        explicit_correction, created_at, updated_at
      ) VALUES (
        'candidate-v16', 'default', 'personal', 'turn-v16', 'run-v16',
        'preference', '用户', '主要编辑器', 'VS Code',
        '用户::主要编辑器', 'candidate-hash', '用户使用 VS Code。',
        0.99, 0.8, 'normal', 'accepted', 0,
        '2026-07-29T00:00:00.000Z',
        '2026-07-29T00:00:00.000Z'
      );
      DROP TRIGGER IF EXISTS conversation_turn_ingest_order_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_owner_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_identity_immutable;
      DROP TABLE IF EXISTS memory_turn_ingest_order;
      PRAGMA user_version = 16;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    const run = migrated
      .prepare(
        `SELECT extractor_id, extractor_version
         FROM extraction_runs WHERE id = 'run-v16'`,
      )
      .get();
    assert.deepEqual({ ...run }, {
      extractor_id: 'memory-extractor',
      extractor_version: 'v1',
    });
    const candidate = migrated
      .prepare(
        `SELECT stable_key
         FROM memory_candidates WHERE id = 'candidate-v16'`,
      )
      .get();
    assert.equal(
      candidate?.stable_key,
      'personal::self::用户::主要编辑器',
    );
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v17 会回填真实提取提示契约版本', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v17-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    database.exec(`
      INSERT INTO conversation_sessions (
        id, user_id, namespace, client_name, external_id,
        started_at, metadata_json
      ) VALUES (
        'session-v17', 'default', 'personal', 'test', 'session-v17',
        '2026-07-29T00:00:00.000Z', '{}'
      );
      INSERT INTO conversation_turns (
        id, session_id, user_id, namespace, external_id, role,
        content, content_hash, occurred_at, created_at, metadata_json
      ) VALUES (
        'turn-v17', 'session-v17', 'default', 'personal', 'turn-v17',
        'user', '我使用 VS Code', 'hash',
        '2026-07-29T00:00:00.000Z',
        '2026-07-29T00:00:00.000Z', '{}'
      );
      INSERT INTO extraction_runs (
        id, turn_id, model, prompt_version, extractor_id,
        extractor_version, prompt_contract_version, status, created_at
      ) VALUES (
        'run-v17', 'turn-v17', 'qwen2.5:14b', 'extract-v1',
        'memory-extractor', 'v1', 'extract-v1',
        'completed', '2026-07-29T00:00:00.000Z'
      );
      ALTER TABLE extraction_runs DROP COLUMN prompt_contract_version;
      DROP TRIGGER IF EXISTS conversation_turn_ingest_order_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_owner_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_identity_immutable;
      DROP TABLE IF EXISTS memory_turn_ingest_order;
      PRAGMA user_version = 17;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    assert.equal(
      migrated
        .prepare(
          `SELECT prompt_contract_version
           FROM extraction_runs WHERE id = 'run-v17'`,
        )
        .get()?.prompt_contract_version,
      'extract-v1',
    );
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v18 会创建自然记忆意图收件箱', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v18-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    database.exec(`
      DROP TABLE memory_action_requests;
      PRAGMA user_version = 18;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    assert.ok(
      migrated
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name = 'memory_action_requests'`,
        )
        .get(),
    );
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v19 会为 tombstone 绑定记忆项和删除世代', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v19-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    const store = new MemoryStore(database);
    const memory = store.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'migration-editor',
      predicateKey: '用户::主要编辑器',
      normalizedValueHash: 'editor-vscode',
      normalizedValue: 'VS Code',
    }).memory;
    store.forget(memory.id);
    database.exec(`
      DROP INDEX memory_tombstones_active_item_idx;
      DROP INDEX memory_tombstones_item_generation_idx;
      ALTER TABLE memory_tombstones DROP COLUMN deletion_generation;
      ALTER TABLE memory_tombstones DROP COLUMN memory_item_id;
      PRAGMA user_version = 19;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    const tombstone = migrated
      .prepare(
        `SELECT memory_item_id, deletion_generation
         FROM memory_tombstones`,
      )
      .get();
    assert.equal(tombstone?.memory_item_id, memory.id);
    assert.equal(tombstone?.deletion_generation, 1);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v20 会为动作收件箱增加可恢复审核租约', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v20-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    database.exec(`
      DROP INDEX memory_action_requests_review_idx;
      DROP TRIGGER IF EXISTS
        memory_action_requests_turn_binding_immutable;
      ALTER TABLE memory_action_requests DROP COLUMN review_claimed_at;
      ALTER TABLE memory_action_requests DROP COLUMN review_token;
      PRAGMA user_version = 20;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    const columns = migrated
      .prepare('PRAGMA table_info(memory_action_requests)')
      .all()
      .map((row) => row.name);
    assert.ok(columns.includes('review_token'));
    assert.ok(columns.includes('review_claimed_at'));
    assert.ok(
      migrated
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index'
             AND name = 'memory_action_requests_review_idx'`,
        )
        .get(),
    );
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v21 无损迁移 legacy Dense 数据并建立稳定 generation 和 active alias', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v21-dense-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  const memoryId = '22222222-2222-4222-8222-222222222222';
  const model = 'legacy-embedding:latest';
  const indexVersion = 'dense-sign-lsh-v1';
  const generationKey = 'legacy-generation-fingerprint';
  const timestamp = '2026-07-29T00:00:00.000Z';

  try {
    const database = openDatabase(filePath);
    insertDenseMigrationMemory(database, memoryId);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX IF EXISTS memory_jobs_affinity_idx;
      ALTER TABLE memory_jobs DROP COLUMN required_generation_id;
      ALTER TABLE memory_jobs DROP COLUMN required_model_id;
      DROP TABLE dense_index_aliases;
      DROP TABLE memory_embeddings;
      DROP TABLE memory_dense_lsh;
      DROP TABLE dense_index_generations;
      DROP TABLE embedding_model_registry;

      CREATE TABLE memory_embeddings (
        memory_id TEXT NOT NULL
          REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        generation_key TEXT,
        memory_revision INTEGER NOT NULL DEFAULT 1,
        embedding BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, model)
      );

      CREATE TABLE memory_dense_lsh (
        memory_id TEXT NOT NULL
          REFERENCES memories(id) ON DELETE CASCADE,
        embedding_model TEXT NOT NULL,
        index_version TEXT NOT NULL,
        band INTEGER NOT NULL CHECK (band >= 0),
        bucket TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dimensions INTEGER,
        generation_key TEXT,
        memory_revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(
          memory_id, embedding_model, index_version, band
        )
      );

      DELETE FROM dense_index_state;
      PRAGMA user_version = 21;
      PRAGMA foreign_keys = ON;
    `);
    database
      .prepare(
        `INSERT INTO dense_index_state (
           embedding_model, index_version, dimensions,
           probed_at, generation_key
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(model, indexVersion, 4, timestamp, generationKey);
    database
      .prepare(
        `INSERT INTO memory_embeddings (
           memory_id, model, text_hash, dimensions, generation_key,
           memory_revision, embedding, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memoryId,
        model,
        'e'.repeat(64),
        4,
        generationKey,
        1,
        new Uint8Array(16),
        timestamp,
      );
    const insertBand = database.prepare(
      `INSERT INTO memory_dense_lsh (
         memory_id, embedding_model, index_version, band, bucket,
         text_hash, updated_at, dimensions, generation_key,
         memory_revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let band = 0; band < 2; band += 1) {
      insertBand.run(
        memoryId,
        model,
        indexVersion,
        band,
        `bucket-${band}`,
        'e'.repeat(64),
        timestamp,
        4,
        generationKey,
        1,
      );
    }
    database.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    const registry = migrated
      .prepare(
        `SELECT model_id, provider, model_name, metadata_json
         FROM embedding_model_registry`,
      )
      .get();
    assert.equal(registry?.provider, 'legacy');
    assert.equal(registry?.model_name, model);
    assert.deepEqual(JSON.parse(String(registry?.metadata_json)), {
      migratedFromSchema: 21,
    });
    assert.match(String(registry?.model_id), /^legacy-model:[0-9a-f]+$/);

    const generation = migrated
      .prepare(
        `SELECT *
         FROM dense_index_generations`,
      )
      .get();
    assert.match(
      String(generation?.generation_id),
      /^legacy-generation:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/,
    );
    assert.equal(generation?.model_id, registry?.model_id);
    assert.equal(generation?.embedding_model, model);
    assert.equal(generation?.index_version, indexVersion);
    assert.equal(generation?.dimensions, 4);
    assert.equal(generation?.generation_key, generationKey);
    assert.equal(generation?.status, 'active');

    const embedding = migrated
      .prepare(
        `SELECT generation_id, model, text_hash, memory_revision
         FROM memory_embeddings
         WHERE memory_id = ?`,
      )
      .get(memoryId);
    assert.equal(
      embedding?.generation_id,
      generation?.generation_id,
    );
    assert.equal(embedding?.model, model);
    assert.equal(embedding?.text_hash, 'e'.repeat(64));
    assert.equal(embedding?.memory_revision, 1);
    assert.equal(
      migrated
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_dense_lsh
           WHERE memory_id = ? AND generation_id = ?`,
        )
        .get(memoryId, generation?.generation_id)?.count,
      2,
    );
    const alias = migrated
      .prepare(
        `SELECT *
         FROM dense_index_aliases
         WHERE user_id = 'default' AND namespace = 'personal'`,
      )
      .get();
    assert.equal(
      alias?.active_generation_id,
      generation?.generation_id,
    );
    assert.equal(alias?.building_generation_id, null);
    assert.equal(alias?.previous_generation_id, null);
    assert.equal(alias?.revision, 1);
    assert.deepEqual(
      migrated.prepare('PRAGMA foreign_key_check').all(),
      [],
    );
    const counts = {
      models: migrated
        .prepare(
          'SELECT COUNT(*) AS count FROM embedding_model_registry',
        )
        .get()?.count,
      generations: migrated
        .prepare(
          'SELECT COUNT(*) AS count FROM dense_index_generations',
        )
        .get()?.count,
      aliases: migrated
        .prepare(
          'SELECT COUNT(*) AS count FROM dense_index_aliases',
        )
        .get()?.count,
      embeddings: migrated
        .prepare('SELECT COUNT(*) AS count FROM memory_embeddings')
        .get()?.count,
      bands: migrated
        .prepare('SELECT COUNT(*) AS count FROM memory_dense_lsh')
        .get()?.count,
    };
    migrated.close();

    const reopened = openDatabase(filePath);
    assert.deepEqual(
      {
        models: reopened
          .prepare(
            'SELECT COUNT(*) AS count FROM embedding_model_registry',
          )
          .get()?.count,
        generations: reopened
          .prepare(
            'SELECT COUNT(*) AS count FROM dense_index_generations',
          )
          .get()?.count,
        aliases: reopened
          .prepare(
            'SELECT COUNT(*) AS count FROM dense_index_aliases',
          )
          .get()?.count,
        embeddings: reopened
          .prepare('SELECT COUNT(*) AS count FROM memory_embeddings')
          .get()?.count,
        bands: reopened
          .prepare('SELECT COUNT(*) AS count FROM memory_dense_lsh')
          .get()?.count,
      },
      counts,
    );
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v23 允许多 generation 共存并只保留 Dense 查询必要索引', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v22-dense-schema-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  const memoryId = '33333333-3333-4333-8333-333333333333';
  const timestamp = '2026-07-29T01:00:00.000Z';

  try {
    const database = openDatabase(filePath);
    insertDenseMigrationMemory(database, memoryId);
    database
      .prepare(
        `INSERT INTO embedding_model_registry (
           model_id, provider, model_name, created_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'model:test-embed',
        'fake',
        'mutable-embed:latest',
        timestamp,
        '{}',
      );
    database
      .prepare(
        `INSERT INTO embedding_model_registry (
           model_id, provider, model_name, created_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'model:test-embed-b',
        'fake',
        'mutable-embed:latest',
        '2026-07-29T01:00:01.000Z',
        '{"revision":"b"}',
      );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM embedding_model_registry
           WHERE provider = 'fake'
             AND model_name = 'mutable-embed:latest'`,
        )
        .get()?.count,
      2,
    );
    const insertGeneration = database.prepare(
      `INSERT INTO dense_index_generations (
         generation_id, model_id, embedding_model, index_version,
         dimensions, generation_key, status, created_at, updated_at,
         ready_at, failure_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertGeneration.run(
      'generation:a',
      'model:test-embed',
      'mutable-embed:latest',
      'dense-sign-lsh-v1',
      4,
      'fingerprint-a',
      'active',
      timestamp,
      timestamp,
      timestamp,
      null,
    );
    insertGeneration.run(
      'generation:b',
      'model:test-embed-b',
      'mutable-embed:latest',
      'dense-sign-lsh-v1',
      4,
      'fingerprint-b',
      'building',
      timestamp,
      timestamp,
      null,
      null,
    );
    const insertEmbedding = database.prepare(
      `INSERT INTO memory_embeddings (
         memory_id, generation_id, model, text_hash, dimensions,
         generation_key, memory_revision, embedding, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEmbedding.run(
      memoryId,
      'generation:a',
      'mutable-embed:latest',
      'a'.repeat(64),
      4,
      'fingerprint-a',
      1,
      new Uint8Array(16),
      timestamp,
    );
    insertEmbedding.run(
      memoryId,
      'generation:b',
      'mutable-embed:latest',
      'b'.repeat(64),
      4,
      'fingerprint-b',
      1,
      new Uint8Array(16),
      timestamp,
    );
    const insertBand = database.prepare(
      `INSERT INTO memory_dense_lsh (
         memory_id, generation_id, embedding_model, index_version,
         band, bucket, text_hash, updated_at, dimensions,
         generation_key, memory_revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertBand.run(
      memoryId,
      'generation:a',
      'mutable-embed:latest',
      'dense-sign-lsh-v1',
      0,
      'bucket-a',
      'a'.repeat(64),
      timestamp,
      4,
      'fingerprint-a',
      1,
    );
    insertBand.run(
      memoryId,
      'generation:b',
      'mutable-embed:latest',
      'dense-sign-lsh-v1',
      0,
      'bucket-b',
      'b'.repeat(64),
      timestamp,
      4,
      'fingerprint-b',
      1,
    );
    database
      .prepare(
        `INSERT INTO dense_index_aliases (
           user_id, namespace, active_generation_id,
           building_generation_id, previous_generation_id,
           revision, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'default',
        'personal',
        'generation:a',
        'generation:b',
        null,
        1,
        timestamp,
      );

    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_embeddings
           WHERE memory_id = ? AND model = ?`,
        )
        .get(memoryId, 'mutable-embed:latest')?.count,
      2,
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_dense_lsh
           WHERE memory_id = ? AND embedding_model = ? AND band = 0`,
        )
        .get(memoryId, 'mutable-embed:latest')?.count,
      2,
    );
    const embeddingPrimaryKey = (
      database
        .prepare('PRAGMA table_info(memory_embeddings)')
        .all() as Array<Record<string, unknown>>
    )
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    assert.deepEqual(
      embeddingPrimaryKey,
      ['memory_id', 'generation_id'],
    );
    const densePrimaryKey = (
      database
        .prepare('PRAGMA table_info(memory_dense_lsh)')
        .all() as Array<Record<string, unknown>>
    )
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name);
    assert.deepEqual(
      densePrimaryKey,
      ['memory_id', 'generation_id', 'band'],
    );
    const denseIndexes = new Set(
      (
        database
          .prepare('PRAGMA index_list(memory_dense_lsh)')
          .all() as Array<Record<string, unknown>>
      ).map((index) => String(index.name)),
    );
    assert.ok(denseIndexes.has('memory_dense_lsh_bucket_idx'));
    for (const redundant of [
      'memory_dense_lsh_watermark_idx',
      'memory_dense_lsh_generation_idx',
      'memory_dense_lsh_generation_key_idx',
      'memory_dense_lsh_revision_idx',
    ]) {
      assert.equal(denseIndexes.has(redundant), false);
    }

    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE dense_index_aliases
             SET building_generation_id = active_generation_id
             WHERE user_id = 'default' AND namespace = 'personal'`,
          )
          .run(),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        insertGeneration.run(
          'generation:invalid',
          'model:test-embed',
          'mutable-embed:latest',
          'dense-sign-lsh-v1',
          4,
          'fingerprint-invalid',
          'invalid',
          timestamp,
          timestamp,
          null,
          null,
        ),
      /CHECK constraint failed/,
    );

    database
      .prepare(
        `INSERT INTO memory_jobs (
           id, job_type, user_id, namespace, payload_json,
           available_at, created_at, updated_at,
           required_model_id, required_generation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'job:affinity-valid',
        'index_memory',
        'default',
        'personal',
        '{}',
        timestamp,
        timestamp,
        timestamp,
        'model:test-embed-b',
        'generation:b',
      );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO memory_jobs (
               id, job_type, user_id, namespace, payload_json,
               available_at, created_at, updated_at,
               required_model_id, required_generation_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'job:affinity-invalid',
            'index_memory',
            'default',
            'personal',
            '{}',
            timestamp,
            timestamp,
            timestamp,
            'model:missing',
            'generation:b',
          ),
      /FOREIGN KEY constraint failed/,
    );

    const aliasBefore = {
      ...database
        .prepare(
          `SELECT *
           FROM dense_index_aliases
           WHERE user_id = 'default' AND namespace = 'personal'`,
        )
        .get(),
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          `UPDATE dense_index_aliases
           SET active_generation_id = 'generation:b',
               building_generation_id = NULL,
               previous_generation_id = 'generation:a',
               revision = revision + 1,
               updated_at = ?
           WHERE user_id = 'default' AND namespace = 'personal'`,
        )
        .run('2026-07-29T01:01:00.000Z');
      database
        .prepare(
          `UPDATE dense_index_generations
           SET status = 'invalid'
           WHERE generation_id = 'generation:b'`,
        )
        .run();
      database.exec('COMMIT');
      assert.fail('预期非法 generation 状态触发回滚');
    } catch (error) {
      database.exec('ROLLBACK');
      assert.match(
        error instanceof Error ? error.message : String(error),
        /CHECK constraint failed/,
      );
    }
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT *
             FROM dense_index_aliases
             WHERE user_id = 'default' AND namespace = 'personal'`,
          )
          .get(),
      },
      aliasBefore,
    );
    assert.equal(
      database
        .prepare(
          `SELECT status
           FROM dense_index_generations
           WHERE generation_id = 'generation:b'`,
        )
        .get()?.status,
      'building',
    );
    assert.deepEqual(
      database.prepare('PRAGMA foreign_key_check').all(),
      [],
    );
    database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v23→v24 提交前故障会完整回滚且备份可恢复', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v24-rollback-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  const content = '迁移故障后必须完整保留的用户事实。';

  try {
    const current = openDatabase(filePath);
    const memory = new MemoryStore(current).remember({
      kind: 'knowledge',
      content,
      stableKey: 'migration-v24-rollback',
      predicateKey: '用户::迁移回滚',
      normalizedValue: '必须保留',
      normalizedValueHash: 'migration-v24-rollback-value',
    }).memory;
    new MemoryStore(current).forget(memory.id, '迁移回滚测试');
    current.exec(`
      DROP INDEX IF EXISTS memory_tombstones_normalized_key_idx;
      DROP TABLE namespace_recall_shadow_comparisons;
      DROP TABLE namespace_rollout_state;
      DROP TABLE namespace_quality_snapshots;
      ALTER TABLE memory_tombstones DROP COLUMN semantic_fingerprint;
      ALTER TABLE memory_tombstones DROP COLUMN normalized_value;
      ALTER TABLE memory_tombstones DROP COLUMN normalized_key;
      ALTER TABLE memory_tombstones DROP COLUMN kind;
      PRAGMA user_version = 23;
    `);
    current.close();

    assert.throws(
      () => openDatabase(filePath, {
        testOnlyBeforeMigrationCommit: ({ fromVersion, toVersion }) => {
          assert.deepEqual(
            { fromVersion, toVersion },
            { fromVersion: 23, toVersion: SCHEMA_VERSION },
          );
          throw new Error('injected migration failure');
        },
      }),
      /injected migration failure/,
    );

    const rolledBack = new DatabaseSync(filePath);
    assert.equal(
      Number(
        rolledBack.prepare('PRAGMA user_version').get()?.user_version,
      ),
      23,
    );
    assert.equal(
      rolledBack
        .prepare('SELECT content FROM memories WHERE id = ?')
        .get(memory.id)?.content,
      content,
    );
    assert.equal(
      rolledBack
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table'
             AND name LIKE 'namespace_%'`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      rolledBack
        .prepare(
          `SELECT COUNT(*) AS count
           FROM pragma_table_info('memory_tombstones')
           WHERE name IN (
             'kind', 'normalized_key', 'normalized_value',
             'semantic_fingerprint'
           )`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      rolledBack.prepare('PRAGMA integrity_check').get()
        ?.integrity_check,
      'ok',
    );
    rolledBack.close();

    const backupDirectory = path.join(
      directory,
      'migration-backups',
    );
    const backupFiles = fs.readdirSync(backupDirectory);
    assert.equal(backupFiles.length, 1);
    const backup = new DatabaseSync(
      path.join(backupDirectory, backupFiles[0]),
      { readOnly: true },
    );
    assert.equal(
      Number(backup.prepare('PRAGMA user_version').get()?.user_version),
      23,
    );
    assert.equal(
      backup
        .prepare('SELECT content FROM memories WHERE id = ?')
        .get(memory.id)?.content,
      content,
    );
    backup.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.equal(
      migrated
        .prepare('SELECT content FROM memories WHERE id = ?')
        .get(memory.id)?.content,
      content,
    );
    assert.equal(
      migrated
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN (
               'namespace_quality_snapshots',
               'namespace_rollout_state',
               'namespace_recall_shadow_comparisons'
             )`,
        )
        .get()?.count,
      3,
    );
    migrated.close();

    const reopened = openDatabase(filePath);
    assert.equal(
      Number(reopened.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.equal(
      reopened
        .prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?')
        .get(memory.id)?.count,
      1,
    );
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v23→v24 遇到无法重建的 active content-hash-only tombstone 会 fail closed 并完整回滚', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v24-orphan-tombstone-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');

  try {
    const current = openDatabase(filePath);
    const store = new MemoryStore(current);
    const memory = store.remember({
      kind: 'preference',
      content: '用户要求被遗忘事实不得在迁移后复活。',
      stableKey: 'personal::self::用户::迁移防复活',
      predicateKey: '用户::迁移防复活',
      normalizedValue: '不得复活',
      normalizedValueHash: 'v24-orphan-tombstone-value',
    }).memory;
    store.forget(memory.id, '构造无法恢复的 legacy tombstone');
    current.exec(`
      UPDATE memory_tombstones
      SET memory_item_id = NULL,
          stable_key = NULL
      WHERE content_hash = '${memory.checksum}';

      DROP INDEX IF EXISTS memory_tombstones_normalized_key_idx;
      DROP TABLE namespace_recall_shadow_comparisons;
      DROP TABLE namespace_rollout_state;
      DROP TABLE namespace_quality_snapshots;
      ALTER TABLE memory_tombstones DROP COLUMN semantic_fingerprint;
      ALTER TABLE memory_tombstones DROP COLUMN normalized_value;
      ALTER TABLE memory_tombstones DROP COLUMN normalized_key;
      ALTER TABLE memory_tombstones DROP COLUMN kind;
      PRAGMA user_version = 23;
    `);
    current.close();

    assert.throws(
      () => openDatabase(filePath),
      /tombstone 指纹回填失败/u,
    );

    const rolledBack = new DatabaseSync(filePath);
    try {
      assert.equal(
        Number(
          rolledBack.prepare('PRAGMA user_version').get()?.user_version,
        ),
        23,
      );
      assert.equal(
        rolledBack
          .prepare(
            `SELECT COUNT(*) AS count
             FROM pragma_table_info('memory_tombstones')
             WHERE name IN (
               'kind', 'normalized_key', 'normalized_value',
               'semantic_fingerprint'
             )`,
          )
          .get()?.count,
        0,
      );
      assert.equal(
        rolledBack
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'namespace_%'`,
          )
          .get()?.count,
        0,
      );
      assert.deepEqual(
        {
          stable_key: rolledBack
            .prepare(
              `SELECT stable_key
               FROM memory_tombstones
               WHERE content_hash = ? AND restored_at IS NULL`,
            )
            .get(memory.checksum)?.stable_key,
          content_hash: rolledBack
            .prepare(
              `SELECT content_hash
               FROM memory_tombstones
               WHERE content_hash = ? AND restored_at IS NULL`,
            )
            .get(memory.checksum)?.content_hash,
        },
        {
          stable_key: null,
          content_hash: memory.checksum,
        },
      );
      assert.equal(
        rolledBack.prepare('PRAGMA integrity_check').get()
          ?.integrity_check,
        'ok',
      );
    } finally {
      rolledBack.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v24→v25 回填 legacy principal 且保持记忆 UUID 不变', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v25-identity-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  const aliceMemoryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const bobMemoryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const turnId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  try {
    const current = openDatabase(filePath);
    insertDenseMigrationMemory(current, aliceMemoryId, 'alice');
    insertDenseMigrationMemory(current, bobMemoryId, 'bob');
    current
      .prepare(
        `INSERT INTO conversation_sessions (
           id, user_id, namespace, client_name, external_id,
           started_at, metadata_json
         ) VALUES (?, 'alice', 'personal', 'airi', 'legacy-chat',
           '2026-07-31T00:00:00.000Z', '{}')`,
      )
      .run(sessionId);
    current
      .prepare(
        `INSERT INTO conversation_turns (
           id, session_id, user_id, namespace, external_id, role,
           content, content_hash, occurred_at, created_at,
           metadata_json
         ) VALUES (
           ?, ?, 'alice', 'personal', 'legacy-turn', 'user',
           'legacy turn', 'legacy-turn-hash',
           '2026-07-31T00:00:00.000Z',
           '2026-07-31T00:00:00.000Z', '{}'
         )`,
      )
      .run(turnId, sessionId);
    current
      .prepare(
        `INSERT INTO outbox_events (
           id, aggregate_type, aggregate_id, event_type,
           payload_json, available_at, created_at
         ) VALUES (
           'legacy-outbox', 'turn', ?, 'turn.recorded', '{}',
           '2026-07-31T00:00:00.000Z',
           '2026-07-31T00:00:00.000Z'
         )`,
      )
      .run(turnId);
    current.exec(`
      DROP INDEX IF EXISTS outbox_events_scope_idx;
      DROP INDEX IF EXISTS conversation_turns_round_role_idx;
      DROP INDEX IF EXISTS conversation_turns_round_user_idx;
      DROP TRIGGER IF EXISTS conversation_rounds_scope_insert;
      DROP TRIGGER IF EXISTS conversation_rounds_assistant_update;
      DROP TRIGGER IF EXISTS conversation_regeneration_requests_scope_insert;
      DROP TRIGGER IF EXISTS conversation_sessions_profile_snapshot_insert;
      DROP TRIGGER IF EXISTS conversation_sessions_profile_snapshot_immutable;
      DROP TRIGGER IF EXISTS persona_chat_profiles_owner_insert;
      ALTER TABLE outbox_events DROP COLUMN namespace;
      ALTER TABLE outbox_events DROP COLUMN user_id;
      ALTER TABLE conversation_turns DROP COLUMN round_id;
      DROP TRIGGER IF EXISTS conversation_sessions_identity_immutable;
      DROP TRIGGER IF EXISTS memory_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_evidence_identity_update;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_update;
      DROP TRIGGER IF EXISTS conversation_turn_ingest_order_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_owner_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_identity_immutable;
      DROP TABLE IF EXISTS memory_turn_ingest_order;
      ALTER TABLE conversation_sessions DROP COLUMN identity_status;
      ALTER TABLE conversation_sessions DROP COLUMN identity_source;
      ALTER TABLE conversation_sessions DROP COLUMN persona_id;
      DROP TABLE IF EXISTS identity_audit_log;
      DROP TABLE IF EXISTS client_persona_bindings;
      DROP TABLE IF EXISTS auth_credentials;
      DROP TABLE IF EXISTS account_principals;
      PRAGMA user_version = 24;
    `);
    current.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    const tables = migrated
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'account_principals',
             'auth_credentials',
             'client_persona_bindings',
             'identity_audit_log'
           )
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [
      'account_principals',
      'auth_credentials',
      'client_persona_bindings',
      'identity_audit_log',
    ]);
    assert.deepEqual(
      migrated
        .prepare(
          `SELECT id
           FROM account_principals
           ORDER BY id`,
        )
        .all()
        .map((row) => row.id),
      ['alice', 'bob', 'default'],
    );
    assert.deepEqual(
      migrated
        .prepare(
          `SELECT id, user_id
           FROM memories
           WHERE id IN (?, ?)
           ORDER BY id`,
        )
        .all(aliceMemoryId, bobMemoryId)
        .map((row) => ({ ...row })),
      [
        { id: aliceMemoryId, user_id: 'alice' },
        { id: bobMemoryId, user_id: 'bob' },
      ],
    );
    assert.deepEqual(
      {
        persona_id: migrated
          .prepare(
            `SELECT persona_id
             FROM conversation_sessions
             WHERE id = ?`,
          )
          .get(sessionId)?.persona_id,
        identity_source: migrated
          .prepare(
            `SELECT identity_source
             FROM conversation_sessions
             WHERE id = ?`,
          )
          .get(sessionId)?.identity_source,
        identity_status: migrated
          .prepare(
            `SELECT identity_status
             FROM conversation_sessions
             WHERE id = ?`,
          )
          .get(sessionId)?.identity_status,
        round_id: migrated
          .prepare(
            `SELECT round_id
             FROM conversation_turns
             WHERE id = ?`,
          )
          .get(turnId)?.round_id,
      },
      {
        persona_id: null,
        identity_source: 'legacy',
        identity_status: 'legacy',
        round_id: null,
      },
    );
    assert.deepEqual(
      {
        ...migrated
          .prepare(
            `SELECT user_id, namespace
             FROM outbox_events
             WHERE id = 'legacy-outbox'`,
          )
          .get(),
      },
      { user_id: 'alice', namespace: 'personal' },
    );
    assert.throws(
      () =>
        migrated
          .prepare(
            `INSERT INTO conversation_sessions (
               id, user_id, namespace, client_name, external_id,
               started_at, metadata_json, identity_source,
               identity_status
             ) VALUES (
               'invalid-identity-status-session', 'alice', 'personal',
               'migration-test', 'invalid-identity-status',
               '2026-07-31T00:00:02.000Z', '{}', 'legacy', 'invalid'
             )`,
          )
          .run(),
      /CHECK constraint failed/u,
    );
    migrated
      .prepare(
        `UPDATE conversation_turns
         SET round_id = 'round-1'
         WHERE id = ?`,
      )
      .run(turnId);
    assert.throws(
      () =>
        migrated
          .prepare(
            `INSERT INTO conversation_turns (
               id, session_id, user_id, namespace, external_id,
               role, content, content_hash, occurred_at, created_at,
               metadata_json, round_id
             ) VALUES (
               'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
               ?, 'alice', 'personal', 'duplicate-round-user',
               'user', 'duplicate', 'duplicate-round-hash',
               '2026-07-31T00:00:01.000Z',
               '2026-07-31T00:00:01.000Z', '{}', 'round-1'
             )`,
          )
          .run(sessionId),
      /UNIQUE constraint failed/u,
    );
    assert.equal(
      migrated.prepare('PRAGMA foreign_key_check').all().length,
      0,
    );
    migrated.close();

    const reopened = openDatabase(filePath);
    assert.equal(
      reopened
        .prepare('SELECT COUNT(*) AS count FROM account_principals')
        .get()?.count,
      3,
    );
    assert.equal(
      reopened.prepare('PRAGMA integrity_check').get()?.integrity_check,
      'ok',
    );
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v25→v26 不会把旧 metadata 提升为可信 project 绑定', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v26-project-binding-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const current = openDatabase(filePath);
    current
      .prepare(
        `INSERT INTO conversation_sessions (
           id, user_id, namespace, client_name, external_id,
           persona_id, project_id, identity_source, identity_status,
           started_at, metadata_json
         ) VALUES (
           'session-v25-project-spoof', 'alice', 'personal', 'airi',
           'legacy-project-chat', 'persona-A', NULL, 'credential',
           'complete', '2026-08-01T00:00:00.000Z', ?
         )`,
      )
      .run(JSON.stringify({ trustedProjectId: 'spoofed-project' }));
    current.exec(`
      DROP TRIGGER IF EXISTS conversation_sessions_identity_immutable;
      DROP TRIGGER IF EXISTS memory_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_evidence_identity_update;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_update;
      DROP INDEX IF EXISTS conversation_sessions_project_idx;
      ALTER TABLE conversation_sessions DROP COLUMN project_id;
      PRAGMA user_version = 25;
    `);
    current.close();

    const migrated = openDatabase(filePath);
    const session = migrated
      .prepare(
        `SELECT project_id, metadata_json
         FROM conversation_sessions
         WHERE id = 'session-v25-project-spoof'`,
      )
      .get();
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.equal(session?.project_id, null);
    assert.equal(
      JSON.parse(String(session?.metadata_json)).trustedProjectId,
      'spoofed-project',
    );
    assert.equal(
      migrated.prepare('PRAGMA integrity_check').get()?.integrity_check,
      'ok',
    );
    assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length, 0);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v25→v26 遇到旧 project scope 时 fail closed 并保留备份', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v26-project-fail-closed-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const current = openDatabase(filePath);
    assert.deepEqual(
      {
        ...current
          .prepare(
            `SELECT schema_version, from_version, attestation_kind,
                    legacy_project_scope_count
             FROM schema_migration_ledger`,
          )
          .get(),
      },
      {
        schema_version: 26,
        from_version: 0,
        attestation_kind: 'migration',
        legacy_project_scope_count: 0,
      },
    );
    assert.throws(
      () =>
        current
          .prepare(
            `UPDATE schema_migration_ledger
             SET applied_at = applied_at`,
          )
          .run(),
      /schema migration ledger is immutable/iu,
    );
    assert.throws(
      () => current.prepare('DELETE FROM schema_migration_ledger').run(),
      /schema migration ledger is immutable/iu,
    );
    const legacyProjectMemory = new MemoryStore(current).remember({
      kind: 'project',
      content: '旧链路中的项目归属无法证明可信。',
      scopeType: 'project',
      scopeKey: 'spoofed-project',
      stableKey: 'project::spoofed-project::旧项目约定',
      predicateKey: '旧项目约定',
      normalizedValue: '无法证明可信',
      normalizedValueHash: 'legacy-project-value',
    }).memory;
    current.exec(`
      DROP TRIGGER IF EXISTS conversation_sessions_identity_immutable;
      DROP TRIGGER IF EXISTS memory_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_evidence_identity_update;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_update;
      DROP INDEX IF EXISTS conversation_sessions_project_idx;
      ALTER TABLE conversation_sessions DROP COLUMN project_id;
      PRAGMA user_version = 25;
    `);
    current.close();

    assert.throws(
      () => openDatabase(filePath),
      /schema v26.*project scope.*人工.*rebind/iu,
    );

    const rolledBack = new DatabaseSync(filePath, { readOnly: true });
    assert.equal(
      Number(rolledBack.prepare('PRAGMA user_version').get()?.user_version),
      25,
    );
    assert.equal(
      rolledBack
        .prepare(
          `SELECT COUNT(*) AS count
           FROM pragma_table_info('conversation_sessions')
           WHERE name = 'project_id'`,
        )
        .get()?.count,
      0,
    );
    const preserved = rolledBack
      .prepare(
        `SELECT m.status, m.scope_type, m.scope_key,
                i.status AS item_status, i.scope_type AS item_scope_type,
                i.scope_key AS item_scope_key
         FROM memories m
         JOIN memory_items i ON i.id = m.id
         WHERE m.id = ?`,
      )
      .get(legacyProjectMemory.id);
    assert.deepEqual(
      { ...preserved },
      {
        status: 'active',
        scope_type: 'project',
        scope_key: 'spoofed-project',
        item_status: 'active',
        item_scope_type: 'project',
        item_scope_key: 'spoofed-project',
      },
    );
    rolledBack.close();

    const backupDirectory = path.join(directory, 'migration-backups');
    const backupFiles = fs.readdirSync(backupDirectory);
    assert.equal(backupFiles.length, 1);
    const backup = new DatabaseSync(
      path.join(backupDirectory, backupFiles[0]),
      { readOnly: true },
    );
    assert.equal(
      Number(backup.prepare('PRAGMA user_version').get()?.user_version),
      25,
    );
    assert.equal(
      backup
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memories
           WHERE scope_type = 'project'`,
        )
        .get()?.count,
      1,
    );
    backup.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v27 persona 绑定迁移为 principal 作用域且保留旧记录', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v28-persona-binding-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  const timestamp = '2026-08-09T00:00:00.000Z';
  try {
    const current = openDatabase(filePath);
    current.exec(`
      INSERT INTO account_principals (
        id, display_name, status, created_at, updated_at
      ) VALUES
        ('alice', 'Alice', 'active', '${timestamp}', '${timestamp}'),
        ('bob', 'Bob', 'active', '${timestamp}', '${timestamp}');
      INSERT INTO client_persona_bindings (
        id, principal_id, client_type, client_instance_id,
        persona_id, display_name, status, created_at,
        updated_at, last_seen_at
      ) VALUES (
        'alice-persona-binding', 'alice', 'airi',
        'local-airi-v1', 'default', 'Alice default', 'active',
        '${timestamp}', '${timestamp}', '${timestamp}'
      );
    `);
    current.close();

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      DROP INDEX client_persona_principal_idx;
      ALTER TABLE client_persona_bindings
        RENAME TO client_persona_bindings_v28;
      CREATE TABLE client_persona_bindings (
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
      INSERT INTO client_persona_bindings
      SELECT * FROM client_persona_bindings_v28;
      DROP TABLE client_persona_bindings_v28;
      CREATE INDEX client_persona_principal_idx
        ON client_persona_bindings(
          principal_id, client_type, status, updated_at DESC
        );
      PRAGMA user_version = 27;
    `);
    legacy.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.equal(
      migrated
        .prepare(
          `SELECT principal_id
           FROM client_persona_bindings
           WHERE id = 'alice-persona-binding'`,
        )
        .get()?.principal_id,
      'alice',
    );
    migrated
      .prepare(
        `INSERT INTO client_persona_bindings (
           id, principal_id, client_type, client_instance_id,
           persona_id, display_name, status, created_at,
           updated_at, last_seen_at
         ) VALUES (
           'bob-persona-binding', 'bob', 'airi', 'local-airi-v1',
           'default', 'Bob default', 'active', ?, ?, ?
         )`,
      )
      .run(timestamp, timestamp, timestamp);
    assert.deepEqual(
      migrated
        .prepare(
          `SELECT principal_id, persona_id
           FROM client_persona_bindings
           WHERE client_type = 'airi'
             AND client_instance_id = 'local-airi-v1'
             AND persona_id = 'default'
           ORDER BY principal_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { principal_id: 'alice', persona_id: 'default' },
        { principal_id: 'bob', persona_id: 'default' },
      ],
    );
    assert.throws(
      () =>
        migrated
          .prepare(
            `INSERT INTO client_persona_bindings (
               id, principal_id, client_type, client_instance_id,
               persona_id, status, created_at, updated_at, last_seen_at
             ) VALUES (
               'alice-duplicate', 'alice', 'airi', 'local-airi-v1',
               'default', 'active', ?, ?, ?
             )`,
          )
          .run(timestamp, timestamp, timestamp),
      /unique/iu,
    );
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('拒绝高于当前代码的未来 schema 版本', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-future-schema-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    openDatabase(filePath).close();
    const future = new DatabaseSync(filePath);
    future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
    future.close();

    assert.throws(
      () => {
        const unexpectedlyOpened = openDatabase(filePath);
        unexpectedlyOpened.close();
      },
      /schema.*未来|future.*schema|newer.*schema/iu,
    );

    const preserved = new DatabaseSync(filePath, { readOnly: true });
    assert.equal(
      Number(preserved.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION + 1,
    );
    preserved.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('伪造 schema v26 不能绕过 project_id 结构和 legacy project 检查', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-forged-v26-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const current = openDatabase(filePath);
    const legacyProjectMemory = new MemoryStore(current).remember({
      kind: 'project',
      content: '伪造版本号不得把旧项目记忆冒充可信 v26 数据。',
      scopeType: 'project',
      scopeKey: 'forged-v26-project',
      stableKey: 'project::forged-v26-project::伪造版本',
      predicateKey: '伪造版本',
      normalizedValue: '不得绕过检查',
      normalizedValueHash: 'forged-v26-project-value',
    }).memory;
    current.close();

    const validV26 = openDatabase(filePath);
    assert.equal(
      validV26
        .prepare('SELECT scope_type FROM memories WHERE id = ?')
        .get(legacyProjectMemory.id)?.scope_type,
      'project',
    );
    validV26.exec(`
      DROP TRIGGER IF EXISTS conversation_sessions_identity_immutable;
      DROP TRIGGER IF EXISTS memory_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_evidence_identity_update;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_update;
      DROP INDEX IF EXISTS conversation_sessions_project_idx;
      ALTER TABLE conversation_sessions DROP COLUMN project_id;
      PRAGMA user_version = 26;
    `);
    validV26.close();

    assert.throws(
      () => {
        const unexpectedlyOpened = openDatabase(filePath);
        unexpectedlyOpened.close();
      },
      /schema v26.*(project_id|project scope)/iu,
    );

    const preserved = new DatabaseSync(filePath, { readOnly: true });
    assert.equal(
      preserved
        .prepare(
          `SELECT COUNT(*) AS count
           FROM pragma_table_info('conversation_sessions')
           WHERE name = 'project_id'`,
        )
        .get()?.count,
      0,
    );
    assert.deepEqual(
      {
        ...preserved
          .prepare(
            `SELECT id, scope_type, scope_key
             FROM memories
             WHERE id = ?`,
          )
          .get(legacyProjectMemory.id),
      },
      {
        id: legacyProjectMemory.id,
        scope_type: 'project',
        scope_key: 'forged-v26-project',
      },
    );
    preserved.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v26 拒绝同名但谓词错误的 project 绑定索引', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v26-invalid-project-index-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const invalid = openDatabase(filePath);
    invalid.exec(`
      DROP INDEX conversation_sessions_project_idx;
      CREATE INDEX conversation_sessions_project_idx
        ON conversation_sessions(
          user_id,
          namespace,
          project_id,
          started_at DESC
        )
        WHERE project_id IS NULL;
    `);
    invalid.close();

    assert.throws(
      () => {
        const unexpectedlyOpened = openDatabase(filePath);
        unexpectedlyOpened.close();
      },
      /schema v26.*conversation_sessions_project_idx.*定义不符/iu,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('无 project scope 的旧版真实 v26 可安全补记迁移证明', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v26-safe-attestation-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const original = openDatabase(filePath);
    const personalMemory = new MemoryStore(original).remember({
      kind: 'preference',
      content: '没有 project scope 的既有个人记忆必须原样保留。',
    }).memory;
    original.close();
    const legacyV26 = new DatabaseSync(filePath);
    legacyV26.exec('DROP TABLE schema_migration_ledger;');
    legacyV26.close();

    const adopted = openDatabase(filePath);
    assert.deepEqual(
      {
        ...adopted
          .prepare(
            `SELECT schema_version, from_version, attestation_kind,
                    legacy_project_scope_count
             FROM schema_migration_ledger`,
          )
          .get(),
      },
      {
        schema_version: 26,
        from_version: 26,
        attestation_kind: 'safe_no_project_adoption',
        legacy_project_scope_count: 0,
      },
    );
    assert.equal(
      adopted
        .prepare('SELECT content FROM memories WHERE id = ?')
        .get(personalMemory.id)?.content,
      personalMemory.content,
    );
    adopted.close();

    const reopened = openDatabase(filePath);
    assert.equal(
      reopened
        .prepare('SELECT COUNT(*) AS count FROM schema_migration_ledger')
        .get()?.count,
      1,
    );
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('旧版 v26 的任意 scope_type 表含 project 数据时禁止安全补记证明', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v26-hidden-project-scope-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const legacyV26 = openDatabase(filePath);
    legacyV26
      .prepare(
        `INSERT INTO derived_consolidations (
           id, memory_id, user_id, namespace, scope_type, scope_key,
           source_set_hash, model, prompt_version, status, generated_at
         ) VALUES (
           'hidden-project-consolidation', NULL, 'default', 'personal',
           'project', 'hidden-project', 'hidden-project-source-set',
           'migration-test', 'v1', 'active',
           '2026-08-02T00:00:00.000Z'
         )`,
      )
      .run();
    legacyV26.exec('DROP TABLE schema_migration_ledger;');
    legacyV26.close();

    assert.throws(
      () => {
        const unexpectedlyOpened = openDatabase(filePath);
        unexpectedlyOpened.close();
      },
      /schema v26.*project scope.*derived_consolidations=1/iu,
    );

    const preserved = new DatabaseSync(filePath, { readOnly: true });
    assert.equal(
      preserved
        .prepare(
          `SELECT COUNT(*) AS count
           FROM derived_consolidations
           WHERE scope_type = 'project'`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      preserved
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table' AND name = 'schema_migration_ledger'`,
        )
        .get()?.count,
      0,
    );
    preserved.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('旧 v25 补造 project_id 和同名索引后仍不能冒充可信 v26', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-forged-v26-complete-shape-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const legacy = openDatabase(filePath);
    const legacyProjectMemory = new MemoryStore(legacy).remember({
      kind: 'project',
      content: '旧 v25 项目记忆不能靠补造列和索引洗成可信数据。',
      scopeType: 'project',
      scopeKey: 'legacy-forged-shape',
      stableKey: 'project::legacy-forged-shape::补造结构',
      predicateKey: '补造结构',
      normalizedValue: '不能洗成可信数据',
      normalizedValueHash: 'legacy-forged-shape-value',
    }).memory;
    legacy.exec(`
      DROP TRIGGER IF EXISTS conversation_sessions_identity_immutable;
      DROP TRIGGER IF EXISTS memory_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_evidence_identity_update;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_update;
      DROP INDEX IF EXISTS conversation_sessions_project_idx;
      ALTER TABLE conversation_sessions DROP COLUMN project_id;
      DROP TABLE IF EXISTS schema_migration_ledger;
      PRAGMA user_version = 25;

      ALTER TABLE conversation_sessions ADD COLUMN project_id TEXT;
      CREATE INDEX conversation_sessions_project_idx
        ON conversation_sessions(
          user_id,
          namespace,
          project_id,
          started_at DESC
        )
        WHERE project_id IS NOT NULL;
      PRAGMA user_version = 26;
    `);
    legacy.close();

    assert.throws(
      () => {
        const unexpectedlyOpened = openDatabase(filePath);
        unexpectedlyOpened.close();
      },
      /schema v26.*(migration|ledger|attestation|project scope)/iu,
    );

    const preserved = new DatabaseSync(filePath, { readOnly: true });
    assert.equal(
      Number(preserved.prepare('PRAGMA user_version').get()?.user_version),
      26,
    );
    assert.equal(
      preserved
        .prepare(
          `SELECT COUNT(*) AS count
           FROM pragma_table_info('conversation_sessions')
           WHERE name = 'project_id'`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      preserved
        .prepare(
          `SELECT scope_type
           FROM memories
           WHERE id = ?`,
        )
        .get(legacyProjectMemory.id)?.scope_type,
      'project',
    );
    assert.equal(
      preserved
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table' AND name = 'schema_migration_ledger'`,
        )
        .get()?.count,
      0,
    );
    preserved.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('迁移备份在取锁后复检文件家族，备份窗口内出现并发写时 fail-closed 拒绝迁移', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v26-backup-lock-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  const originalContent = '写锁建立前已经提交的项目事实。';
  const racedContent = '备份后、迁移锁前偷偷写入的竞态事实。';
  try {
    const current = openDatabase(filePath);
    const legacyProjectMemory = new MemoryStore(current).remember({
      kind: 'project',
      content: originalContent,
      scopeType: 'project',
      scopeKey: 'migration-lock-project',
      stableKey: 'project::migration-lock-project::迁移快照',
      predicateKey: '迁移快照',
      normalizedValue: '必须一致',
      normalizedValueHash: 'migration-lock-project-value',
    }).memory;
    current.exec(`
      DROP TRIGGER IF EXISTS conversation_sessions_identity_immutable;
      DROP TRIGGER IF EXISTS memory_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_evidence_identity_update;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_update;
      DROP INDEX IF EXISTS conversation_sessions_project_idx;
      ALTER TABLE conversation_sessions DROP COLUMN project_id;
      PRAGMA user_version = 25;
    `);
    current.close();

    // 备份完成到取得写锁之间没有写锁保护，并发写会成功落库。
    let competingWriteSucceeded = false;
    assert.throws(
      () => openDatabase(filePath, {
        testOnlyAfterMigrationBackup: () => {
          const competitor = new DatabaseSync(filePath);
          competitor.exec('PRAGMA busy_timeout = 0;');
          try {
            competitor
              .prepare('UPDATE memories SET content = ? WHERE id = ?')
              .run(racedContent, legacyProjectMemory.id);
            competingWriteSucceeded = true;
          } finally {
            competitor.close();
          }
        },
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /检测到迁移备份之后、取得写锁之前的并发写入/u);
        // 判据必须落在 -wal 上：WAL 模式下并发写不落主库文件
        assert.match(message, /-wal 大小 \d+ → \d+ 字节/u);
        return true;
      },
    );
    // 该窗口本就没有写锁，竞争写必然成功——这正是取锁后必须复检的原因
    assert.equal(competingWriteSucceeded, true);

    // fail-closed：迁移整体未执行，库停在原 schema 上，并发写的内容保留原样
    const live = new DatabaseSync(filePath, { readOnly: true });
    assert.equal(
      Number(live.prepare('PRAGMA user_version').get()?.user_version),
      25,
    );
    assert.equal(
      live
        .prepare('SELECT content FROM memories WHERE id = ?')
        .get(legacyProjectMemory.id)?.content,
      racedContent,
    );
    live.close();

    // 备份快照仍是漂移发生之前的状态，可用于事后取证
    const backupDirectory = path.join(directory, 'migration-backups');
    const backupFiles = fs.readdirSync(backupDirectory);
    assert.equal(backupFiles.length, 1);
    const backup = new DatabaseSync(
      path.join(backupDirectory, backupFiles[0]),
      { readOnly: true },
    );
    assert.equal(
      backup
        .prepare('SELECT content FROM memories WHERE id = ?')
        .get(legacyProjectMemory.id)?.content,
      originalContent,
    );
    assert.equal(
      Number(backup.prepare('PRAGMA user_version').get()?.user_version),
      25,
    );
    backup.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('可信 schema v26 ledger v1 会原子升级为带身份触发器的 v2', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v26-ledger-v1-upgrade-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const legacyV1 = openDatabase(filePath);
    const fixture = insertIdentityImmutabilityFixture(legacyV1);
    legacyV1.exec(`
      DROP TRIGGER conversation_sessions_identity_immutable;
      DROP TRIGGER conversation_turns_identity_immutable;
      DROP TRIGGER memory_action_requests_identity_immutable;
      DROP TRIGGER memory_action_requests_turn_binding_immutable;
      DROP TRIGGER schema_migration_ledger_immutable_update;
      DROP TRIGGER schema_migration_ledger_immutable_delete;

      UPDATE schema_migration_ledger
      SET migration_key = 'v26-project-binding-no-legacy-project-v1',
          schema_fingerprint =
            '7a9b3d2693b082da4e76ce2347e8e112d8093b104cf2fed6f4711d00ee7a4238';

      CREATE TRIGGER schema_migration_ledger_immutable_update
      BEFORE UPDATE ON schema_migration_ledger
      BEGIN
        SELECT RAISE(ABORT, 'schema migration ledger is immutable');
      END;

      CREATE TRIGGER schema_migration_ledger_immutable_delete
      BEFORE DELETE ON schema_migration_ledger
      BEGIN
        SELECT RAISE(ABORT, 'schema migration ledger is immutable');
      END;
    `);
    legacyV1.close();

    const upgraded = openDatabase(filePath);
    assert.deepEqual(
      {
        ...upgraded
          .prepare(
            `SELECT migration_key, schema_fingerprint
             FROM schema_migration_ledger`,
          )
          .get(),
      },
      {
        migration_key:
          'v26-project-binding-and-identity-immutability-v2',
        schema_fingerprint:
          'b79c003a65253b8b2c748904fda7f55489fd1f435faf4365f8e1aea1a86b7504',
      },
    );
    assert.equal(
      upgraded
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'trigger'
             AND name IN (
               'conversation_sessions_identity_immutable',
               'conversation_turns_identity_immutable',
               'memory_action_requests_identity_immutable',
               'memory_action_requests_turn_binding_immutable'
             )`,
        )
        .get()?.count,
      4,
    );
    assert.throws(
      () =>
        upgraded
          .prepare(
            `UPDATE conversation_sessions
             SET project_id = 'project-B'
             WHERE id = ?`,
          )
          .run(fixture.sessionId),
      /conversation session identity is immutable/iu,
    );
    upgraded.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v26 ledger v2 拒绝同名但被削弱的身份触发器', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v26-weakened-trigger-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const weakened = openDatabase(filePath);
    weakened.exec(`
      DROP TRIGGER conversation_turns_identity_immutable;
      CREATE TRIGGER conversation_turns_identity_immutable
      BEFORE UPDATE OF user_id ON conversation_turns
      BEGIN
        SELECT RAISE(ABORT, 'conversation turn identity is immutable');
      END;
    `);
    weakened.close();

    assert.throws(
      () => {
        const unexpectedlyOpened = openDatabase(filePath);
        unexpectedlyOpened.close();
      },
      /schema v26.*identity immutability trigger.*不可信/iu,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v26 会话身份列建立后不可变，但允许结束和治理 metadata', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-session-identity-immutable-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    const fixture = insertIdentityImmutabilityFixture(database);
    const mutations: Array<[string, string]> = [
      ['user_id', 'alice'],
      ['namespace', 'other'],
      ['client_name', 'other-client'],
      ['external_id', 'other-session'],
      ['persona_id', 'persona-B'],
      ['project_id', 'project-B'],
      ['identity_source', 'mcp_trusted'],
      ['identity_status', 'legacy'],
    ];
    for (const [column, value] of mutations) {
      assert.throws(
        () =>
          database
            .prepare(
              `UPDATE conversation_sessions
               SET ${column} = ?
               WHERE id = ?`,
            )
            .run(value, fixture.sessionId),
        /conversation session identity is immutable/iu,
      );
    }

    database
      .prepare(
        `UPDATE conversation_sessions
         SET ended_at = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        '2026-08-02T01:00:00.000Z',
        JSON.stringify({ governed: true }),
        fixture.sessionId,
      );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT project_id, ended_at, metadata_json
             FROM conversation_sessions
             WHERE id = ?`,
          )
          .get(fixture.sessionId),
      },
      {
        project_id: 'project-A',
        ended_at: '2026-08-02T01:00:00.000Z',
        metadata_json: JSON.stringify({ governed: true }),
      },
    );
    database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v26 turn 归属列建立后不可变，但允许内容和 metadata 脱敏', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-turn-identity-immutable-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    const fixture = insertIdentityImmutabilityFixture(database);
    const mutations: Array<[string, string]> = [
      ['session_id', fixture.otherSessionId],
      ['user_id', 'alice'],
      ['namespace', 'other'],
      ['external_id', 'other-turn'],
      ['role', 'assistant'],
    ];
    for (const [column, value] of mutations) {
      assert.throws(
        () =>
          database
            .prepare(
              `UPDATE conversation_turns
               SET ${column} = ?
               WHERE id = ?`,
            )
            .run(value, fixture.turnId),
        /conversation turn identity is immutable/iu,
      );
    }

    database
      .prepare(
        `UPDATE conversation_turns
         SET content = '[redacted]', content_hash = ?, metadata_json = ?
         WHERE id = ?`,
      )
      .run(
        'redacted-content-hash',
        JSON.stringify({ redacted: true }),
        fixture.turnId,
      );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT session_id, content, content_hash, metadata_json
             FROM conversation_turns
             WHERE id = ?`,
          )
          .get(fixture.turnId),
      },
      {
        session_id: fixture.sessionId,
        content: '[redacted]',
        content_hash: 'redacted-content-hash',
        metadata_json: JSON.stringify({ redacted: true }),
      },
    );
    database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v26 action 归属不可变且 turn 只能初绑或物理清除', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-action-identity-immutable-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    const fixture = insertIdentityImmutabilityFixture(database);
    const mutations: Array<[string, string]> = [
      ['user_id', 'alice'],
      ['namespace', 'other'],
      ['request_key', 'other-request'],
      ['action', 'correct'],
    ];
    for (const [column, value] of mutations) {
      assert.throws(
        () =>
          database
            .prepare(
              `UPDATE memory_action_requests
               SET ${column} = ?
               WHERE id = ?`,
            )
            .run(value, fixture.actionRequestId),
        /memory action request identity is immutable/iu,
      );
    }

    database
      .prepare(
        `UPDATE memory_action_requests
         SET status = 'failed', review_token = ?, review_claimed_at = ?,
             error = 'review retry'
         WHERE id = ?`,
      )
      .run(
        'review-token',
        '2026-08-02T00:05:00.000Z',
        fixture.actionRequestId,
      );
    database
      .prepare(
        `UPDATE memory_action_requests
         SET turn_id = ?
         WHERE id = ?`,
      )
      .run(fixture.turnId, fixture.actionRequestId);

    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE memory_action_requests
             SET turn_id = ?
             WHERE id = ?`,
          )
          .run(fixture.otherTurnId, fixture.actionRequestId),
      /memory action request turn binding is immutable/iu,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE memory_action_requests
             SET turn_id = NULL
             WHERE id = ?`,
          )
          .run(fixture.actionRequestId),
      /memory action request turn binding is immutable/iu,
    );

    database
      .prepare(
        `UPDATE memory_action_requests
         SET turn_id = NULL,
             status = 'rejected',
             target_query = '[purged]',
             target_memory_id = NULL,
             candidate_id = NULL,
             candidate_json = NULL,
             rationale = 'physical_purge',
             error = NULL,
             review_token = NULL,
             review_claimed_at = NULL
         WHERE id = ?`,
      )
      .run(fixture.actionRequestId);
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE memory_action_requests
             SET turn_id = ?
             WHERE id = ?`,
          )
          .run(fixture.otherTurnId, fixture.actionRequestId),
      /memory action request turn binding is immutable/iu,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE memory_action_requests
             SET rationale = 'review_reopened'
             WHERE id = ?`,
          )
          .run(fixture.actionRequestId),
      /memory action request turn binding is immutable/iu,
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT user_id, namespace, request_key, action, status,
                    turn_id, rationale, review_token
             FROM memory_action_requests
             WHERE id = ?`,
          )
          .get(fixture.actionRequestId),
      },
      {
        user_id: 'default',
        namespace: 'personal',
        request_key: 'identity-action-request-A',
        action: 'forget',
        status: 'rejected',
        turn_id: null,
        rationale: 'physical_purge',
        review_token: null,
      },
    );
    database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v30 reopen 会拒绝缺失的 reflection claim 唯一索引', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v30-index-attestation-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    openDatabase(filePath).close();
    const corrupted = new DatabaseSync(filePath);
    corrupted.exec(
      'DROP INDEX memory_reflection_claims_candidate_idx',
    );
    corrupted.close();

    assert.throws(
      () => openDatabase(filePath),
      /reflection.*唯一索引|唯一索引.*reflection/iu,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v30 reopen 会拒绝同名但被削弱的 reflection owner 触发器', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v30-trigger-attestation-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    openDatabase(filePath).close();
    const corrupted = new DatabaseSync(filePath);
    corrupted.exec(`
      DROP TRIGGER memory_candidate_evidence_owner_insert;
      CREATE TRIGGER memory_candidate_evidence_owner_insert
      BEFORE INSERT ON memory_candidate_evidence
      BEGIN
        SELECT 1;
      END;
    `);
    corrupted.close();

    assert.throws(
      () => openDatabase(filePath),
      /reflection.*触发器|触发器.*reflection/iu,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v30 reopen 会拒绝 reflection 账本中的外键孤儿', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v30-fk-attestation-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    openDatabase(filePath).close();
    const corrupted = new DatabaseSync(filePath);
    corrupted.exec('PRAGMA foreign_keys = OFF');
    corrupted.prepare(
      `INSERT INTO memory_reflection_model_calls (
         id, run_id, user_id, namespace, budget_day, call_type,
         model, estimated_tokens, status, reserved_at
       ) VALUES (
         'orphan-reflection-call', 'missing-reflection-run',
         'alice', 'personal', '2026-08-09', 'reflect',
         'qwen2.5:14b', 1, 'failed', '2026-08-09T00:00:00.000Z'
       )`,
    ).run();
    corrupted.close();

    assert.throws(
      () => openDatabase(filePath),
      /reflection.*外键|foreign key.*reflection|reflection.*foreign key/iu,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v31 ingest ledger 固化 session 归属并命中增量索引', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v31-ingest-session-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    const fixture = insertIdentityImmutabilityFixture(database);
    assert.deepEqual(
      {
        ...database.prepare(
          `SELECT turn_id, session_id, user_id, namespace
           FROM memory_turn_ingest_order
           WHERE turn_id = ?`,
        ).get(fixture.turnId),
      },
      {
        turn_id: fixture.turnId,
        session_id: fixture.sessionId,
        user_id: 'default',
        namespace: 'personal',
      },
    );
    const plan = database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT ingest_seq
       FROM memory_turn_ingest_order
         INDEXED BY memory_turn_ingest_session_idx
       WHERE user_id = ? AND namespace = ?
         AND session_id = ? AND ingest_seq > ?
       ORDER BY ingest_seq ASC
       LIMIT 40`,
    ).all('default', 'personal', fixture.sessionId, 0);
    assert.ok(plan.some((row) =>
      String(row.detail).includes('memory_turn_ingest_session_idx')
    ));
    assert.throws(
      () => database.prepare(
        `UPDATE memory_turn_ingest_order
         SET session_id = ? WHERE turn_id = ?`,
      ).run(fixture.otherSessionId, fixture.turnId),
      /turn ingest identity is immutable/iu,
    );
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v30 ingest ledger 原子迁移到 v31 session 增量目录', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v30-to-v31-ingest-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const current = openDatabase(filePath);
    const fixture = insertIdentityImmutabilityFixture(current);
    current.close();

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TRIGGER conversation_turn_ingest_order_insert;
      DROP TRIGGER memory_turn_ingest_order_owner_insert;
      DROP TRIGGER memory_turn_ingest_order_identity_immutable;
      DROP INDEX memory_turn_ingest_owner_idx;
      DROP INDEX memory_turn_ingest_session_idx;
      ALTER TABLE memory_turn_ingest_order
        RENAME TO memory_turn_ingest_order_v31;
      CREATE TABLE memory_turn_ingest_order (
        ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );
      INSERT INTO memory_turn_ingest_order (
        ingest_seq, turn_id, user_id, namespace, ingested_at
      )
      SELECT ingest_seq, turn_id, user_id, namespace, ingested_at
      FROM memory_turn_ingest_order_v31
      ORDER BY ingest_seq;
      DROP TABLE memory_turn_ingest_order_v31;
      CREATE INDEX memory_turn_ingest_owner_idx
        ON memory_turn_ingest_order(user_id, namespace, ingest_seq ASC);
      CREATE TRIGGER conversation_turn_ingest_order_insert
      AFTER INSERT ON conversation_turns
      BEGIN
        INSERT OR IGNORE INTO memory_turn_ingest_order (
          turn_id, user_id, namespace, ingested_at
        ) VALUES (NEW.id, NEW.user_id, NEW.namespace, NEW.created_at);
      END;
      PRAGMA user_version = 30;
    `);
    legacy.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.equal(
      migrated.prepare(
        `SELECT session_id FROM memory_turn_ingest_order
         WHERE turn_id = ?`,
      ).get(fixture.turnId)?.session_id,
      fixture.sessionId,
    );
    assert.equal(
      migrated.prepare(
        `SELECT COUNT(*) AS count FROM memory_turn_ingest_order`,
      ).get()?.count,
      2,
    );
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v31 reopen 会拒绝缺失的 session ingest 索引', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v31-ingest-index-attestation-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    openDatabase(filePath).close();
    const corrupted = new DatabaseSync(filePath);
    corrupted.exec('DROP INDEX memory_turn_ingest_session_idx');
    corrupted.close();
    assert.throws(
      () => openDatabase(filePath),
      /schema v31 reflection 索引缺失/iu,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v36 原子升级到 v37 并保留会话数据与既有约束', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v36-to-v37-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const current = openDatabase(filePath);
    const fixture = insertIdentityImmutabilityFixture(current);
    current.close();

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE conversation_memory_summary_sources;
      DROP TABLE conversation_memory_summaries;
      DROP TABLE memory_pattern_observations;
      DROP TABLE conversation_episode_turns;
      DROP TABLE conversation_episodes;
      PRAGMA user_version = 36;
    `);
    legacy.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.equal(
      migrated.prepare(
        `SELECT session_id FROM conversation_turns WHERE id = ?`,
      ).get(fixture.turnId)?.session_id,
      fixture.sessionId,
    );
    const migratedTables = new Set(
      migrated.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'conversation_episodes',
           'conversation_episode_turns',
           'memory_pattern_observations',
           'conversation_memory_summaries',
           'conversation_memory_summary_sources'
         )`,
      ).all().map((row) => String(row.name)),
    );
    assert.equal(migratedTables.size, 5);
    const retainedConversationTriggers = new Set(
      migrated.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name IN (
           'conversation_project_bindings_identity_immutable',
           'conversation_rounds_scope_insert',
           'conversation_regeneration_requests_scope_insert',
           'conversation_sessions_deleted_terminal'
         )`,
      ).all().map((row) => String(row.name)),
    );
    assert.equal(retainedConversationTriggers.size, 4);
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 37 升级到 38 时合并旧巩固积压并启用持续去重', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v38-job-coalescing-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const initial = openDatabase(filePath);
    const memory = new MemoryStore(initial).remember({
      kind: 'preference',
      content: '用户偏好深色主题。',
      stableKey: '用户::数据库迁移去重偏好',
      source: 'automatic-extraction',
    }).memory;
    initial.close();

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      DELETE FROM memory_jobs;
      DROP TABLE conversation_episode_compactions;
      PRAGMA user_version = 37;
    `);
    const insertLegacyJob = legacy.prepare(
      `INSERT INTO memory_jobs (
         id, job_type, user_id, namespace, payload_json, status,
         priority, attempts, max_attempts, available_at,
         created_at, updated_at
       ) VALUES (
         ?, 'consolidate_memory_change', 'default', 'personal', ?,
         'pending', 1, 0, 5, ?, ?, ?
       )`,
    );
    insertLegacyJob.run(
      'legacy-consolidation-old',
      JSON.stringify({ memoryId: memory.id, eventId: 'legacy-old' }),
      '2026-07-28T00:00:00.000Z',
      '2026-07-28T00:00:00.000Z',
      '2026-07-28T00:00:00.000Z',
    );
    insertLegacyJob.run(
      'legacy-consolidation-new',
      JSON.stringify({ memoryId: memory.id, eventId: 'legacy-new' }),
      '2026-07-29T00:00:00.000Z',
      '2026-07-29T00:00:00.000Z',
      '2026-07-29T00:00:00.000Z',
    );
    legacy.prepare(
      `INSERT INTO memory_reflection_runs (
         id, user_id, namespace, scope_type, scope_key, run_type,
         trigger, status, turn_set_hash, model, prompt_version,
         extractor_id, extractor_version, implementation_version,
         requested_by, completed_at, created_at, updated_at
       ) VALUES (
         'legacy-partial-run', 'default', 'personal', 'personal',
         'self', 'reflect', 'sweep', 'partial', 'legacy-turn-set',
         'qwen2.5:14b', 'legacy-reflection-v1', 'legacy-extractor',
         '1', 'legacy-implementation', 'legacy-sweep', ?, ?, ?
       )`,
    ).run(
      '2026-07-29T00:00:00.000Z',
      '2026-07-28T00:00:00.000Z',
      '2026-07-29T00:00:00.000Z',
    );
    legacy.prepare(
      `INSERT INTO memory_jobs (
         id, job_type, user_id, namespace, payload_json, status,
         priority, attempts, max_attempts, available_at,
         created_at, updated_at
       ) VALUES (
         'legacy-partial-reflection-job', 'reflect_turn_window',
         'default', 'personal', ?, 'pending', 1, 0, 5, ?, ?, ?
       )`,
    ).run(
      JSON.stringify({ runId: 'legacy-partial-run' }),
      '2026-07-28T00:00:00.000Z',
      '2026-07-28T00:00:00.000Z',
      '2026-07-28T00:00:00.000Z',
    );
    legacy.close();

    const migrated = openDatabase(filePath);
    const migratedRows = migrated.prepare(
      `SELECT id, status, last_error
       FROM memory_jobs
       WHERE job_type = 'consolidate_memory_change'
       ORDER BY id`,
    ).all() as Array<Record<string, unknown>>;
    assert.equal(migratedRows.length, 2);
    assert.equal(
      migratedRows.find((row) => row.id === 'legacy-consolidation-old')
        ?.status,
      'completed',
    );
    assert.match(
      String(migratedRows.find(
        (row) => row.id === 'legacy-consolidation-old',
      )?.last_error || ''),
      /coalesced_during_schema38_migration/u,
    );
    assert.equal(
      migratedRows.find((row) => row.id === 'legacy-consolidation-new')
        ?.status,
      'pending',
    );
    const retiredReflectionJob = migrated.prepare(
      `SELECT status, last_error
       FROM memory_jobs
       WHERE id = 'legacy-partial-reflection-job'`,
    ).get();
    assert.equal(retiredReflectionJob?.status, 'completed');
    assert.equal(
      retiredReflectionJob?.last_error,
      'reflection_run_already_terminal',
    );

    new MemoryStore(migrated).update(memory.id, {
      content: '用户明确修正为偏好浅色主题。',
    });
    assert.equal(
      migrated.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_jobs
         WHERE job_type = 'consolidate_memory_change'
           AND status = 'pending'`,
      ).get()?.count,
      1,
    );
    assert.match(
      String(migrated.prepare(
        `SELECT last_error FROM memory_jobs
         WHERE id = 'legacy-consolidation-new'`,
      ).get()?.last_error || ''),
      /coalesced_by_newer_memory_event/u,
    );
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema v38 分层表、索引、精炼记录和巩固触发器结构可重开', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v38-layered-memory-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    assert.equal(
      Number(database.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    const tables = new Set(database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'conversation_episodes',
         'conversation_episode_turns',
         'memory_pattern_observations',
         'conversation_memory_summaries',
         'conversation_memory_summary_sources',
         'conversation_episode_compactions'
       )`,
    ).all().map((row) => String(row.name)));
    assert.equal(tables.size, 6);
    const indexes = new Set(database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name IN (
         'conversation_episodes_owner_time_idx',
         'conversation_episodes_session_idx',
         'conversation_episode_turns_turn_idx',
         'memory_pattern_observations_claim_idx',
         'memory_pattern_observations_turn_idx',
         'conversation_memory_summaries_scope_idx',
         'conversation_memory_summary_sources_source_idx',
         'conversation_episode_compactions_owner_idx',
         'memory_evidence_turn_version_idx'
       )`,
    ).all().map((row) => String(row.name)));
    assert.equal(indexes.size, 9);
    const episodeColumns = new Set(
      database.prepare('PRAGMA table_info(conversation_episodes)')
        .all().map((row) => String(row.name)),
    );
    for (const column of [
      'memory_id',
      'session_id',
      'user_turn_id',
      'assistant_turn_id',
      'scope_type',
      'scope_key',
      'content_hash',
      'status',
    ]) {
      assert.equal(episodeColumns.has(column), true, column);
    }
    const triggerSql = String(database.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'memory_event_consolidation_job'`,
    ).get()?.sql || '').toLowerCase();
    for (const source of [
      'conversation_episode',
      'hierarchical_summary',
      'consolidation',
    ]) {
      assert.match(triggerSql, new RegExp(source, 'u'));
    }
    database.close();

    const reopened = openDatabase(filePath);
    assert.equal(
      Number(reopened.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
    reopened.close();

    const stale = new DatabaseSync(filePath);
    stale.exec(`
      DROP TRIGGER memory_event_consolidation_job;
      DROP INDEX memory_evidence_turn_version_idx;
      CREATE TRIGGER memory_event_consolidation_job
      AFTER INSERT ON memory_events
      WHEN new.memory_item_id IS NOT NULL
      BEGIN SELECT 1; END;
    `);
    stale.close();

    const repaired = openDatabase(filePath);
    const repairedSql = String(repaired.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'memory_event_consolidation_job'`,
    ).get()?.sql || '').toLowerCase();
    for (const source of [
      'conversation_episode',
      'hierarchical_summary',
      'consolidation',
    ]) {
      assert.match(repairedSql, new RegExp(source, 'u'));
    }
    assert.equal(
      Boolean(repaired.prepare(
        `SELECT 1 FROM sqlite_master
         WHERE type = 'index'
           AND name = 'memory_evidence_turn_version_idx'`,
      ).get()),
      true,
    );
    assert.deepEqual(repaired.prepare('PRAGMA foreign_key_check').all(), []);
    repaired.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 38 升级到 39 时保留证据并安装可自修复的证据边界触发器', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v39-evidence-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const current = openDatabase(filePath);
    const turn = new LifecycleStore(current).recordTurn({
      userId: 'alice',
      namespace: 'namespace-a',
      personaId: 'persona-a',
      projectId: 'project-a',
      identitySource: 'schema39-test',
      identityStatus: 'complete',
      roundId: 'round-schema39',
      clientName: 'schema39-test',
      sessionExternalId: 'session-schema39',
      turnExternalId: 'turn-schema39',
      role: 'user',
      content: 'schema 39 迁移必须保留这条原始证据。',
    }).turn;
    const memory = new MemoryStore(current).remember({
      userId: 'alice',
      namespace: 'namespace-a',
      kind: 'relationship',
      content: 'Alice 与 persona-a 有经过原话支持的约定。',
      scopeType: 'role',
      scopeKey: 'persona-a',
      evidenceTurnId: turn.id,
      evidenceExcerpt: turn.content,
    }).memory;
    const evidenceId = String(current.prepare(
      `SELECT id FROM memory_evidence
       WHERE memory_version_id = (
         SELECT current_version_id FROM memory_items WHERE id = ?
       )`,
    ).get(memory.id)?.id || '');
    assert.notEqual(evidenceId, '');
    current.close();

    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      DROP TRIGGER memory_evidence_owner_insert;
      DROP TRIGGER memory_evidence_identity_update;
      PRAGMA user_version = 38;
    `);
    legacy.close();

    const migrated = openDatabase(filePath);
    assert.equal(
      Number(migrated.prepare('PRAGMA user_version').get()?.user_version),
      SCHEMA_VERSION,
    );
    assert.equal(
      migrated.prepare(
        `SELECT turn_id FROM memory_evidence WHERE id = ?`,
      ).get(evidenceId)?.turn_id,
      turn.id,
    );
    const triggerNames = new Set(migrated.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'trigger' AND name IN (
         'memory_evidence_owner_insert',
         'memory_evidence_identity_update'
       )`,
    ).all().map((row) => String(row.name)));
    assert.deepEqual(triggerNames, new Set([
      'memory_evidence_owner_insert',
      'memory_evidence_identity_update',
    ]));
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    migrated.close();

    const backupDirectory = path.join(directory, 'migration-backups');
    const backupFiles = fs.readdirSync(backupDirectory).filter(
      (name) => name.includes('schema-38-to-'),
    );
    assert.equal(backupFiles.length, 1);
    const backup = new DatabaseSync(
      path.join(backupDirectory, backupFiles[0]),
      { readOnly: true },
    );
    assert.equal(
      Number(backup.prepare('PRAGMA user_version').get()?.user_version),
      38,
    );
    assert.equal(
      backup.prepare(
        `SELECT turn_id FROM memory_evidence WHERE id = ?`,
      ).get(evidenceId)?.turn_id,
      turn.id,
    );
    backup.close();

    const stale = new DatabaseSync(filePath);
    stale.exec(`
      DROP TRIGGER memory_evidence_owner_insert;
      CREATE TRIGGER memory_evidence_owner_insert
      BEFORE INSERT ON memory_evidence
      BEGIN SELECT 1; END;
    `);
    stale.close();
    const repaired = openDatabase(filePath);
    const repairedSql = String(repaired.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'memory_evidence_owner_insert'`,
    ).get()?.sql || '').toLowerCase();
    assert.match(repairedSql, /owner\/scope mismatch/u);
    assert.match(repairedSql, /conversation_sessions/u);
    assert.deepEqual(repaired.prepare('PRAGMA foreign_key_check').all(), []);
    repaired.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
