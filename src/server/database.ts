import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  backfillTombstoneSemanticFingerprints,
} from './tombstone-policy.js';
import { withSqliteBusyRetry } from './sqlite-retry.js';
import {
  normalizeSchemaSql,
  V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY,
  V26_IDENTITY_IMMUTABILITY_SCHEMA_FINGERPRINT,
  V26_IDENTITY_IMMUTABILITY_TRIGGERS,
  V26_PROJECT_BINDING_MIGRATION_KEY_V1,
  V26_PROJECT_BINDING_SCHEMA_FINGERPRINT_V1,
  V31_REFLECTION_TRIGGERS,
  V32_CONVERSATION_TRIGGERS,
  V33_CONVERSATION_ROUND_TRIGGERS,
  V35_CONVERSATION_REGENERATION_TRIGGERS,
  V36_CONVERSATION_DELETION_TRIGGERS,
  V37_MEMORY_EVIDENCE_TURN_INDEX,
  V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER,
  V39_MEMORY_EVIDENCE_TRIGGERS,
} from './schema-sql.js';

export const SCHEMA_VERSION = 44;
const IDENTITY_SCHEMA_VERSION = 26;

export interface OpenDatabaseOptions {
  testOnlyAfterMigrationBackup?: () => void;
  testOnlyBeforeMigrationCommit?: (input: {
    fromVersion: number;
    toVersion: number;
  }) => void;
}

function journalMode(database: DatabaseSync): string {
  const row = database.prepare('PRAGMA journal_mode').get();
  return String(row?.journal_mode ?? '').trim().toLowerCase();
}

function ensureWalJournalMode(
  database: DatabaseSync,
  filePath: string,
): void {
  const observed = journalMode(database);
  if (filePath === ':memory:' || observed === 'memory') return;
  if (observed !== 'wal') {
    withSqliteBusyRetry(
      () => database.prepare('PRAGMA journal_mode = WAL').get(),
      {
        operation: 'configure SQLite WAL mode',
        maxAttempts: 8,
        totalBudgetMs: 15_000,
      },
    );
  }
  const verified = journalMode(database);
  if (verified !== 'wal') {
    throw new Error(
      `SQLite 文件数据库无法进入 WAL 模式（当前模式：${verified || 'unknown'}）`,
    );
  }
}

export function openDatabase(
  filePath: string,
  options: OpenDatabaseOptions = {},
): DatabaseSync {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA secure_delete = ON;');
  try {
    migrate(database, filePath, options);
    ensureWalJournalMode(database, filePath);
  } catch (error) {
    database.close();
    throw error;
  }
  database.exec('PRAGMA synchronous = NORMAL;');
  database.exec('PRAGMA cache_size = -65536;');
  database.exec('PRAGMA mmap_size = 268435456;');
  database.exec('PRAGMA temp_store = MEMORY;');
  return database;
}

function backupBeforeMigration(
  filePath: string,
  observedVersion: number,
): boolean {
  if (filePath === ':memory:' || !fs.existsSync(filePath)) return false;
  if (
    observedVersion >= SCHEMA_VERSION ||
    fs.statSync(filePath).size === 0
  ) {
    return false;
  }

  const backupDirectory = path.join(
    path.dirname(filePath),
    'migration-backups',
  );
  fs.mkdirSync(backupDirectory, { recursive: true });
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);
  const timestamp = new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');
  const backupPath = path.join(
    backupDirectory,
    `${baseName}-schema-${observedVersion}-to-${SCHEMA_VERSION}-${timestamp}${extension || '.sqlite3'}`,
  );
  // 迁移备份 = wal_checkpoint(TRUNCATE) + 文件复制。
  // 不用 VACUUM INTO 的原因（macOS node:sqlite 实测，SQLITE_IOERR
  // disk I/O error，且稳定复现与否取决于目录/状态，无法依赖）：
  // ① 主连接持有写事务（BEGIN IMMEDIATE）时必失败；
  // ② 源库 WAL 非空时必失败；
  // ③ 数据目录在 ~/Documents（iCloud/Spotlight 干扰）时间歇失败。
  // checkpoint 先把 WAL 全量合入主库文件，冷启动场景（openDatabase
  // 取迁移锁之前，无并发写者）随后复制主文件即等价一致性快照。
  // 本函数必须在取迁移写锁之前调用。
  const snapshotSource = new DatabaseSync(filePath);
  try {
    snapshotSource.exec('PRAGMA busy_timeout = 5000;');
    snapshotSource.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    fs.copyFileSync(filePath, backupPath);
  } finally {
    snapshotSource.close();
  }
  return true;
}

function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  column: string,
  statement: string,
): void {
  if (hasColumn(database, table, column)) return;
  database.exec(statement);
}

function hasColumn(
  database: DatabaseSync,
  table: string,
  column: string,
): boolean {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<Record<string, unknown>>;
  return columns.some((entry) => entry.name === column);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function installIdentityImmutabilityTriggers(
  database: DatabaseSync,
): void {
  for (const trigger of V26_IDENTITY_IMMUTABILITY_TRIGGERS) {
    database.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)}`);
    database.exec(trigger.sql);
  }
}

function assertIdentityImmutabilityTriggers(
  database: DatabaseSync,
): void {
  const names = V26_IDENTITY_IMMUTABILITY_TRIGGERS.map(
    (trigger) => trigger.name,
  );
  const rows = database
    .prepare(
      `SELECT name, tbl_name, sql
       FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (${names.map(() => '?').join(', ')})`,
    )
    .all(...names) as Array<Record<string, unknown>>;
  const actualByName = new Map(
    rows.map((row) => [String(row.name), row]),
  );
  const exactMatch =
    rows.length === V26_IDENTITY_IMMUTABILITY_TRIGGERS.length &&
    V26_IDENTITY_IMMUTABILITY_TRIGGERS.every((trigger) => {
      const actual = actualByName.get(trigger.name);
      return (
        actual?.tbl_name === trigger.table &&
        normalizeSchemaSql(String(actual.sql ?? '')) ===
          normalizeSchemaSql(trigger.sql)
      );
    });
  if (!exactMatch) {
    throw new Error(
      'schema v26 identity immutability trigger 定义缺失或不可信。',
    );
  }
}

function backfillLegacyPrincipals(
  database: DatabaseSync,
  timestamp: string,
): void {
  const principalIds = new Set<string>(['default']);
  const tables = database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<Record<string, unknown>>;

  for (const table of tables) {
    const tableName = String(table.name ?? '').trim();
    if (!tableName) continue;
    const columns = database
      .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
      .all() as Array<Record<string, unknown>>;
    if (!columns.some((column) => column.name === 'user_id')) {
      continue;
    }
    const rows = database
      .prepare(
        `SELECT DISTINCT user_id
         FROM ${quoteIdentifier(tableName)}
         WHERE user_id IS NOT NULL
           AND TRIM(user_id) != ''`,
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const principalId = String(row.user_id ?? '').trim();
      if (principalId) principalIds.add(principalId);
    }
  }

  const insert = database.prepare(
    `INSERT OR IGNORE INTO account_principals (
       id, display_name, status, created_at, updated_at
     ) VALUES (?, ?, 'active', ?, ?)`,
  );
  for (const principalId of [...principalIds].sort()) {
    insert.run(principalId, principalId, timestamp, timestamp);
  }
}

function assertNoLegacyProjectScopes(
  database: DatabaseSync,
): void {
  const scopedTables = (
    database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<Record<string, unknown>>
  )
    .map((row) => String(row.name ?? '').trim())
    .filter(
      (table) =>
        table && hasColumn(database, quoteIdentifier(table), 'scope_type'),
    );
  const populated = scopedTables.flatMap((table) => {
    const count = Number(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM ${quoteIdentifier(table)}
           WHERE scope_type = 'project'`,
        )
        .get()?.count || 0,
    );
    return count > 0 ? [`${table}=${count}`] : [];
  });
  if (populated.length === 0) return;

  throw new Error(
    'schema v26 migration blocked: legacy project scope 数据没有可信的' +
      ' session.project_id 归属，禁止自动改写（' +
      `${populated.join(', ')}）。请从 migration-backups 备份执行` +
      '离线人工 quarantine/rebind 后再迁移。',
  );
}

function schemaVersion(database: DatabaseSync): number {
  return Number(
    database.prepare('PRAGMA user_version').get()?.user_version || 0,
  );
}

function assertSupportedSchemaVersion(version: number): void {
  if (version <= SCHEMA_VERSION) return;
  throw new Error(
    `数据库 schema ${version} 来自未来版本，当前代码只支持到 ` +
      `schema ${SCHEMA_VERSION}；为避免旧代码破坏新结构，已拒绝打开。`,
  );
}

function hasCurrentV38ConsolidationTrigger(
  database: DatabaseSync,
): boolean {
  const row = database.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'memory_event_consolidation_job'`,
  ).get();
  return normalizeSchemaSql(String(row?.sql ?? '')) ===
    normalizeSchemaSql(V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER);
}

function installV39MemoryEvidenceTriggers(
  database: DatabaseSync,
): void {
  for (const trigger of V39_MEMORY_EVIDENCE_TRIGGERS) {
    database.exec(
      `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)};`,
    );
    database.exec(trigger.sql);
  }
}

function hasCurrentV39MemoryEvidenceTriggers(
  database: DatabaseSync,
): boolean {
  const rows = database.prepare(
    `SELECT name, tbl_name, sql
     FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (${
         V39_MEMORY_EVIDENCE_TRIGGERS.map(() => '?').join(', ')
       })`,
  ).all(
    ...V39_MEMORY_EVIDENCE_TRIGGERS.map((trigger) => trigger.name),
  ) as Array<Record<string, unknown>>;
  const byName = new Map(
    rows.map((row) => [String(row.name ?? ''), row]),
  );
  return V39_MEMORY_EVIDENCE_TRIGGERS.every((expected) => {
    const actual = byName.get(expected.name);
    return Boolean(actual) &&
      String(actual?.tbl_name ?? '') === expected.table &&
      normalizeSchemaSql(String(actual?.sql ?? '')) ===
        normalizeSchemaSql(expected.sql);
  });
}

function hasSchemaMigrationLedger(database: DatabaseSync): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = 'schema_migration_ledger'`,
      )
      .get(),
  );
}

function createSchemaMigrationLedger(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_migration_ledger (
      schema_version INTEGER PRIMARY KEY,
      migration_key TEXT NOT NULL UNIQUE,
      from_version INTEGER NOT NULL,
      attestation_kind TEXT NOT NULL
        CHECK (attestation_kind IN (
          'migration', 'safe_no_project_adoption'
        )),
      schema_fingerprint TEXT NOT NULL,
      legacy_project_scope_count INTEGER NOT NULL
        CHECK (legacy_project_scope_count = 0),
      applied_at TEXT NOT NULL CHECK (length(trim(applied_at)) > 0),
      CHECK (
        (attestation_kind = 'migration'
          AND from_version >= 0
          AND from_version < schema_version)
        OR
        (attestation_kind = 'safe_no_project_adoption'
          AND from_version = schema_version)
      )
    );

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
}

type V26AttestationKind = 'migration' | 'safe_no_project_adoption';
type V26LedgerGeneration = 'v1' | 'v2';

interface V26SchemaAttestation {
  generation: V26LedgerGeneration;
  fromVersion: number;
  attestationKind: V26AttestationKind;
}

function recordV26CurrentSchemaAttestation(
  database: DatabaseSync,
  fromVersion: number,
  attestationKind: V26AttestationKind,
): void {
  database
    .prepare(
      `INSERT INTO schema_migration_ledger (
         schema_version,
         migration_key,
         from_version,
         attestation_kind,
         schema_fingerprint,
         legacy_project_scope_count,
         applied_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      IDENTITY_SCHEMA_VERSION,
      V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY,
      fromVersion,
      attestationKind,
      V26_IDENTITY_IMMUTABILITY_SCHEMA_FINGERPRINT,
      new Date().toISOString(),
    );
}

function replaceV26SchemaAttestation(
  database: DatabaseSync,
  attestation: Pick<
    V26SchemaAttestation,
    'fromVersion' | 'attestationKind'
  >,
): void {
  database.exec('DROP TABLE schema_migration_ledger;');
  createSchemaMigrationLedger(database);
  recordV26CurrentSchemaAttestation(
    database,
    attestation.fromVersion,
    attestation.attestationKind,
  );
}

function hasCurrentV26SchemaAttestation(database: DatabaseSync): boolean {
  if (!hasSchemaMigrationLedger(database)) return false;
  const attestation = database
    .prepare(
      `SELECT migration_key, schema_fingerprint
       FROM schema_migration_ledger
       WHERE schema_version = ?`,
    )
    .get(IDENTITY_SCHEMA_VERSION);
  return (
    attestation?.migration_key ===
      V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY &&
    attestation?.schema_fingerprint ===
      V26_IDENTITY_IMMUTABILITY_SCHEMA_FINGERPRINT
  );
}

function assertSchemaMigrationLedger(
  database: DatabaseSync,
  allowLegacyV1 = false,
): V26SchemaAttestation {
  const columns = database
    .prepare('PRAGMA table_info(schema_migration_ledger)')
    .all() as Array<Record<string, unknown>>;
  const expectedColumns = [
    ['schema_version', 'INTEGER', 0, 1],
    ['migration_key', 'TEXT', 1, 0],
    ['from_version', 'INTEGER', 1, 0],
    ['attestation_kind', 'TEXT', 1, 0],
    ['schema_fingerprint', 'TEXT', 1, 0],
    ['legacy_project_scope_count', 'INTEGER', 1, 0],
    ['applied_at', 'TEXT', 1, 0],
  ] as const;
  const structureMatches =
    columns.length === expectedColumns.length &&
    expectedColumns.every((expected, index) => {
      const actual = columns[index];
      return (
        actual?.name === expected[0] &&
        String(actual.type ?? '').toUpperCase() === expected[1] &&
        Number(actual.notnull ?? 0) === expected[2] &&
        Number(actual.pk ?? 0) === expected[3]
      );
    });
  if (!structureMatches) {
    throw new Error(
      'schema v26 migration ledger 结构无效，拒绝信任 project 绑定。',
    );
  }

  const triggerRows = database
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (
           'schema_migration_ledger_immutable_update',
           'schema_migration_ledger_immutable_delete'
         )`,
    )
    .all() as Array<Record<string, unknown>>;
  const triggerSql = new Map(
    triggerRows.map((row) => [
      String(row.name),
      String(row.sql ?? '').replaceAll(/\s+/gu, ' ').toLowerCase(),
    ]),
  );
  if (
    !triggerSql
      .get('schema_migration_ledger_immutable_update')
      ?.includes('before update on schema_migration_ledger') ||
    !triggerSql
      .get('schema_migration_ledger_immutable_update')
      ?.includes("raise(abort, 'schema migration ledger is immutable')") ||
    !triggerSql
      .get('schema_migration_ledger_immutable_delete')
      ?.includes('before delete on schema_migration_ledger') ||
    !triggerSql
      .get('schema_migration_ledger_immutable_delete')
      ?.includes("raise(abort, 'schema migration ledger is immutable')")
  ) {
    throw new Error(
      'schema v26 migration ledger 缺少不可变保护，拒绝信任 project 绑定。',
    );
  }

  const attestation = database
    .prepare(
      `SELECT *
       FROM schema_migration_ledger
       WHERE schema_version = ?`,
    )
    .get(IDENTITY_SCHEMA_VERSION) as
      Record<string, unknown> | undefined;
  const kind = String(attestation?.attestation_kind ?? '');
  const fromVersion = Number(attestation?.from_version ?? -1);
  const validOrigin =
    (kind === 'migration' &&
      fromVersion >= 0 &&
      fromVersion < IDENTITY_SCHEMA_VERSION) ||
    (kind === 'safe_no_project_adoption' &&
      fromVersion === IDENTITY_SCHEMA_VERSION);
  const currentAttestation =
    attestation?.migration_key ===
      V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY &&
    attestation?.schema_fingerprint ===
      V26_IDENTITY_IMMUTABILITY_SCHEMA_FINGERPRINT;
  const legacyV1Attestation =
    attestation?.migration_key === V26_PROJECT_BINDING_MIGRATION_KEY_V1 &&
    attestation?.schema_fingerprint ===
      V26_PROJECT_BINDING_SCHEMA_FINGERPRINT_V1;
  if (
    !attestation ||
    (!currentAttestation && !(allowLegacyV1 && legacyV1Attestation)) ||
    Number(attestation.legacy_project_scope_count ?? -1) !== 0 ||
    !validOrigin ||
    Number.isNaN(Date.parse(String(attestation.applied_at ?? '')))
  ) {
    throw new Error(
      'schema v26 migration ledger 缺少可信的 project/identity ' +
        'fail-closed 证明。',
    );
  }
  return {
    generation: currentAttestation ? 'v2' : 'v1',
    fromVersion,
    attestationKind: kind as V26AttestationKind,
  };
}

function assertCurrentProjectBindingStructure(
  database: DatabaseSync,
): void {
  const requiredScopedTables = [
    'memories',
    'memory_items',
    'memory_versions',
    'memory_candidates',
    'memory_tombstones',
    'derived_consolidations',
  ];
  const invalidScopedTables = requiredScopedTables.filter(
    (table) => !hasColumn(database, table, 'scope_type'),
  );
  if (invalidScopedTables.length > 0) {
    throw new Error(
      'schema v26 结构无效：缺少 project scope 载体字段（' +
        `${invalidScopedTables.join(', ')}）。`,
    );
  }
  const columns = database
    .prepare('PRAGMA table_info(conversation_sessions)')
    .all() as Array<Record<string, unknown>>;
  const projectId = columns.find((column) => column.name === 'project_id');
  if (!projectId) {
    throw new Error(
      'schema v26 结构无效：conversation_sessions.project_id 缺失；' +
        '拒绝把可能包含 legacy project scope 的数据库当作可信 v26。',
    );
  }
  if (
    String(projectId.type ?? '').trim().toUpperCase() !== 'TEXT' ||
    Number(projectId.notnull ?? 0) !== 0 ||
    Number(projectId.pk ?? 0) !== 0 ||
    projectId.dflt_value !== null
  ) {
    throw new Error(
      'schema v26 结构无效：conversation_sessions.project_id ' +
        '必须是可空 TEXT。',
    );
  }
  const projectIndex = database
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'index'
         AND name = 'conversation_sessions_project_idx'
         AND tbl_name = 'conversation_sessions'`,
    )
    .get();
  if (!projectIndex) {
    throw new Error(
      'schema v26 结构无效：conversation_sessions_project_idx 缺失。',
    );
  }
  const indexList = database
    .prepare('PRAGMA index_list(conversation_sessions)')
    .all() as Array<Record<string, unknown>>;
  const listedProjectIndex = indexList.find(
    (index) => index.name === 'conversation_sessions_project_idx',
  );
  const indexColumns = (
    database
      .prepare('PRAGMA index_xinfo(conversation_sessions_project_idx)')
      .all() as Array<Record<string, unknown>>
  )
    .filter((column) => Number(column.key) === 1)
    .sort((left, right) => Number(left.seqno) - Number(right.seqno))
    .map((column) => [String(column.name), Number(column.desc)]);
  const expectedIndexColumns = [
    ['user_id', 0],
    ['namespace', 0],
    ['project_id', 0],
    ['started_at', 1],
  ];
  const normalizedIndexSql = String(projectIndex.sql ?? '')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  if (
    Number(listedProjectIndex?.unique ?? -1) !== 0 ||
    Number(listedProjectIndex?.partial ?? -1) !== 1 ||
    !normalizedIndexSql.endsWith('where project_id is not null') ||
    indexColumns.length !== expectedIndexColumns.length ||
    !expectedIndexColumns.every(
      (expected, index) =>
        indexColumns[index]?.[0] === expected[0] &&
        indexColumns[index]?.[1] === expected[1],
    )
  ) {
    throw new Error(
      'schema v26 结构无效：conversation_sessions_project_idx 定义不符。',
    );
  }
}

function assertRetrievalObservabilityStructure(
  database: DatabaseSync,
): void {
  const requiredTables = [
    'retrieval_traces',
    'retrieval_trace_events',
    'retrieval_feedback_examples',
    'retrieval_log_state',
  ];
  const existing = new Set(
    (
      database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN (${requiredTables.map(() => '?').join(', ')})`,
        )
        .all(...requiredTables) as Array<Record<string, unknown>>
    ).map((row) => String(row.name)),
  );
  const missing = requiredTables.filter((table) => !existing.has(table));
  if (missing.length > 0) {
    throw new Error(
      `schema v27 retrieval observability 结构缺失（${missing.join(', ')}）。`,
    );
  }
  const requiredTraceColumns = [
    'trace_id',
    'user_id',
    'namespace',
    'log_mode',
    'query_hash',
    'query_text',
    'quality_state',
    'result_count',
    'total_duration_ms',
    'started_at',
    'completed_at',
  ];
  const traceColumns = new Set(
    (
      database.prepare('PRAGMA table_info(retrieval_traces)').all() as
        Array<Record<string, unknown>>
    ).map((column) => String(column.name)),
  );
  const missingColumns = requiredTraceColumns.filter(
    (column) => !traceColumns.has(column),
  );
  if (missingColumns.length > 0) {
    throw new Error(
      'schema v27 retrieval_traces 字段缺失（' +
        `${missingColumns.join(', ')}）。`,
    );
  }
}

function assertPrincipalScopedPersonaBindingStructure(
  database: DatabaseSync,
): void {
  const uniqueIndexes = (
    database.prepare('PRAGMA index_list(client_persona_bindings)').all() as
      Array<Record<string, unknown>>
  ).filter((index) => Number(index.unique ?? 0) === 1);
  const uniqueColumnSets = uniqueIndexes.map((index) =>
    (
      database
        .prepare(
          `PRAGMA index_info(${quoteIdentifier(String(index.name ?? ''))})`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((column) => String(column.name ?? ''))
  );
  const expected = [
    'principal_id',
    'client_type',
    'client_instance_id',
    'persona_id',
  ];
  if (
    !uniqueColumnSets.some(
      (columns) =>
        columns.length === expected.length &&
        expected.every((column, index) => columns[index] === column),
    )
  ) {
    throw new Error(
      'schema v28 client persona 绑定必须按 principal 隔离。',
    );
  }
}


function assertReflectionStructure(database: DatabaseSync): void {
  const requiredTables = [
    'memory_reflection_settings',
    'memory_reflection_checkpoints',
    'memory_reflection_runs',
    'memory_candidate_evidence',
    'memory_turn_ingest_order',
    'memory_reflection_run_turns',
    'memory_reflection_model_calls',
    'memory_reflection_claims',
    'memory_reflection_events',
  ];
  const existing = new Set(
    (
      database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN (${requiredTables.map(() => '?').join(', ')})`,
        )
        .all(...requiredTables) as Array<Record<string, unknown>>
    ).map((row) => String(row.name)),
  );
  const missing = requiredTables.filter((table) => !existing.has(table));
  if (missing.length > 0) {
    throw new Error(
      `schema v31 reflection 结构缺失（${missing.join(', ')}）。`,
    );
  }
  const requiredColumns: Record<string, readonly string[]> = {
    memory_candidates: [
      'reflection_run_id', 'candidate_origin', 'claim_fingerprint',
    ],
    memory_reflection_settings: [
      'user_id', 'namespace', 'mode', 'daily_call_limit',
    ],
    memory_reflection_checkpoints: [
      'id', 'user_id', 'namespace', 'scope_type', 'scope_key',
      'run_type', 'generation_key', 'last_ingest_seq',
    ],
    memory_reflection_runs: [
      'id', 'user_id', 'namespace', 'scope_type', 'scope_key',
      'run_type', 'status', 'turn_set_hash', 'generation_key',
      'lease_owner', 'lease_until', 'cancel_requested_at',
    ],
    memory_candidate_evidence: [
      'candidate_id', 'turn_id', 'excerpt', 'excerpt_hash',
      'evidence_type', 'ordinal', 'user_id', 'namespace',
      'scope_type', 'scope_key',
    ],
    memory_turn_ingest_order: [
      'ingest_seq', 'turn_id', 'session_id', 'user_id', 'namespace',
    ],
    memory_reflection_run_turns: [
      'run_id', 'turn_id', 'ingest_seq', 'turn_alias',
      'ordinal', 'content_hash',
    ],
    memory_reflection_model_calls: [
      'id', 'run_id', 'user_id', 'namespace', 'budget_day',
      'call_type', 'model', 'estimated_tokens', 'status', 'reserved_at',
    ],
    memory_reflection_claims: [
      'user_id', 'namespace', 'scope_type', 'scope_key',
      'claim_fingerprint', 'candidate_id', 'decision',
      'first_run_id', 'last_run_id',
    ],
    memory_reflection_events: [
      'id', 'run_id', 'user_id', 'namespace',
      'event_type', 'detail_json', 'created_at',
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(
      (
        database.prepare(
          `PRAGMA table_info(${quoteIdentifier(table)})`,
        ).all() as Array<Record<string, unknown>>
      ).map((column) => String(column.name ?? '')),
    );
    const missingColumns = columns.filter((column) => !actual.has(column));
    if (missingColumns.length > 0) {
      throw new Error(
        `schema v31 reflection ${table} 字段缺失（` +
          `${missingColumns.join(', ')}）。`,
      );
    }
  }

  const hasUniqueIndex = (
    table: string,
    columns: readonly string[],
    partialPredicate?: string,
  ): boolean => {
    const indexes = database.prepare(
      `PRAGMA index_list(${quoteIdentifier(table)})`,
    ).all() as Array<Record<string, unknown>>;
    return indexes.some((index) => {
      if (Number(index.unique ?? 0) !== 1) return false;
      if (partialPredicate && Number(index.partial ?? 0) !== 1) return false;
      const indexName = String(index.name ?? '');
      const actualColumns = (
        database.prepare(
          `PRAGMA index_info(${quoteIdentifier(indexName)})`,
        ).all() as Array<Record<string, unknown>>
      ).map((column) => String(column.name ?? ''));
      if (
        actualColumns.length !== columns.length ||
        !columns.every((column, position) =>
          actualColumns[position] === column)
      ) {
        return false;
      }
      if (!partialPredicate) return true;
      const definition = database.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = ?`,
      ).get(indexName) as Record<string, unknown> | undefined;
      return normalizeSchemaSql(String(definition?.sql ?? '')).includes(
        normalizeSchemaSql(partialPredicate),
      );
    });
  };
  const requiredUniqueIndexes: Array<{
    table: string;
    columns: readonly string[];
    predicate?: string;
  }> = [
    {
      table: 'memory_reflection_checkpoints',
      columns: [
        'user_id', 'namespace', 'scope_type', 'scope_key',
        'run_type', 'generation_key',
      ],
    },
    {
      table: 'memory_reflection_runs',
      columns: [
        'user_id', 'namespace', 'scope_type', 'scope_key', 'run_type',
        'turn_set_hash', 'implementation_version',
      ],
    },
    {
      table: 'memory_reflection_claims',
      columns: [
        'user_id', 'namespace', 'scope_type', 'scope_key',
        'claim_fingerprint',
      ],
    },
    {
      table: 'memory_reflection_claims',
      columns: ['candidate_id'],
      predicate: 'where candidate_id is not null',
    },
  ];
  for (const index of requiredUniqueIndexes) {
    if (!hasUniqueIndex(index.table, index.columns, index.predicate)) {
      throw new Error(
        `schema v31 reflection 唯一索引缺失或定义不一致（` +
          `${index.table}: ${index.columns.join(', ')}）。`,
      );
    }
  }

  const hasIndex = (
    table: string,
    columns: readonly string[],
  ): boolean => (
    database.prepare(
      `PRAGMA index_list(${quoteIdentifier(table)})`,
    ).all() as Array<Record<string, unknown>>
  ).some((index) => {
    const indexName = String(index.name ?? '');
    const actualColumns = (
      database.prepare(
        `PRAGMA index_info(${quoteIdentifier(indexName)})`,
      ).all() as Array<Record<string, unknown>>
    ).map((column) => String(column.name ?? ''));
    return actualColumns.length === columns.length && columns.every(
      (column, position) => actualColumns[position] === column,
    );
  });
  const requiredIndexes: Array<{
    table: string;
    columns: readonly string[];
  }> = [
    {
      table: 'memory_turn_ingest_order',
      columns: ['user_id', 'namespace', 'ingest_seq'],
    },
    {
      table: 'memory_turn_ingest_order',
      columns: ['user_id', 'namespace', 'session_id', 'ingest_seq'],
    },
  ];
  for (const index of requiredIndexes) {
    if (!hasIndex(index.table, index.columns)) {
      throw new Error(
        `schema v31 reflection 索引缺失或定义不一致（` +
          `${index.table}: ${index.columns.join(', ')}）。`,
      );
    }
  }

  const triggerNames = V31_REFLECTION_TRIGGERS.map(
    (trigger) => trigger.name,
  );
  const triggerRows = database.prepare(
    `SELECT name, tbl_name, sql FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (${triggerNames.map(() => '?').join(', ')})`,
  ).all(...triggerNames) as Array<Record<string, unknown>>;
  const triggerByName = new Map(
    triggerRows.map((row) => [String(row.name ?? ''), row]),
  );
  const normalizeTriggerSql = (sql: string): string =>
    normalizeSchemaSql(sql).replace(
      /^create trigger if not exists /u,
      'create trigger ',
    );
  for (const expected of V31_REFLECTION_TRIGGERS) {
    const actual = triggerByName.get(expected.name);
    if (
      !actual ||
      String(actual.tbl_name ?? '') !== expected.table ||
      normalizeTriggerSql(String(actual.sql ?? '')) !==
        normalizeTriggerSql(expected.sql)
    ) {
      throw new Error(
        `schema v31 reflection 触发器缺失或定义不一致（` +
          `${expected.name}）。`,
      );
    }
  }

  const hasForeignKey = (
    table: string,
    from: string,
    targetTable: string,
    to: string,
    onDelete: string,
  ): boolean => (
    database.prepare(
      `PRAGMA foreign_key_list(${quoteIdentifier(table)})`,
    ).all() as Array<Record<string, unknown>>
  ).some((foreignKey) =>
    String(foreignKey.from ?? '') === from &&
    String(foreignKey.table ?? '') === targetTable &&
    String(foreignKey.to ?? '') === to &&
    String(foreignKey.on_delete ?? '').toUpperCase() === onDelete
  );
  const requiredForeignKeys = [
    ['memory_turn_ingest_order', 'turn_id', 'conversation_turns', 'id', 'CASCADE'],
    ['memory_turn_ingest_order', 'session_id', 'conversation_sessions', 'id', 'CASCADE'],
    ['memory_candidate_evidence', 'candidate_id', 'memory_candidates', 'id', 'CASCADE'],
    ['memory_candidate_evidence', 'turn_id', 'conversation_turns', 'id', 'CASCADE'],
    ['memory_reflection_run_turns', 'run_id', 'memory_reflection_runs', 'id', 'CASCADE'],
    ['memory_reflection_run_turns', 'turn_id', 'conversation_turns', 'id', 'RESTRICT'],
    ['memory_reflection_model_calls', 'run_id', 'memory_reflection_runs', 'id', 'CASCADE'],
    ['memory_reflection_claims', 'candidate_id', 'memory_candidates', 'id', 'SET NULL'],
    ['memory_reflection_claims', 'first_run_id', 'memory_reflection_runs', 'id', 'RESTRICT'],
    ['memory_reflection_claims', 'last_run_id', 'memory_reflection_runs', 'id', 'RESTRICT'],
    ['memory_reflection_events', 'run_id', 'memory_reflection_runs', 'id', 'CASCADE'],
  ] as const;
  for (const [table, from, targetTable, to, onDelete] of requiredForeignKeys) {
    if (!hasForeignKey(table, from, targetTable, to, onDelete)) {
      throw new Error(
        `schema v31 reflection 外键缺失或定义不一致（` +
          `${table}.${from} -> ${targetTable}.${to}）。`,
      );
    }
  }
  const invalidIngestRows = Number(
    database.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_turn_ingest_order o
       LEFT JOIN conversation_turns t ON t.id = o.turn_id
       LEFT JOIN conversation_sessions s ON s.id = o.session_id
       WHERE t.id IS NULL OR s.id IS NULL
          OR t.session_id != o.session_id
          OR t.user_id != o.user_id OR t.namespace != o.namespace
          OR s.user_id != o.user_id OR s.namespace != o.namespace`,
    ).get()?.count || 0,
  );
  if (invalidIngestRows > 0) {
    throw new Error(
      `schema v31 ingest ledger owner/session 校验失败（` +
        `${invalidIngestRows} 行）。`,
    );
  }
  const invalidCandidateEvidenceRows = Number(
    database.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_candidate_evidence e
       LEFT JOIN memory_candidates c ON c.id = e.candidate_id
       LEFT JOIN conversation_turns t ON t.id = e.turn_id
       LEFT JOIN conversation_sessions s ON s.id = t.session_id
       WHERE c.id IS NULL OR t.id IS NULL OR s.id IS NULL
          OR c.user_id != e.user_id OR c.namespace != e.namespace
          OR c.scope_type != e.scope_type OR c.scope_key != e.scope_key
          OR t.user_id != c.user_id OR t.namespace != c.namespace
          OR s.user_id != c.user_id OR s.namespace != c.namespace
          OR NOT (
            (c.scope_type = 'personal' AND c.scope_key = 'self')
            OR (c.scope_type = 'role' AND s.persona_id = c.scope_key)
            OR (c.scope_type = 'project' AND s.project_id = c.scope_key)
            OR (c.scope_type = 'session' AND s.external_id = c.scope_key)
          )`,
    ).get()?.count || 0,
  );
  if (invalidCandidateEvidenceRows > 0) {
    throw new Error(
      `schema v31 reflection candidate evidence scope 校验失败（` +
        `${invalidCandidateEvidenceRows} 行）。`,
    );
  }
  const foreignKeyViolations = database
    .prepare('PRAGMA foreign_key_check')
    .all() as Array<Record<string, unknown>>;
  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `schema v31 reflection 外键校验失败（` +
        `${foreignKeyViolations.length} 个孤儿引用）。`,
    );
  }
}

function assertConversationAuthorityStructure(
  database: DatabaseSync,
): void {
  const requiredColumns: Record<string, readonly string[]> = {
    conversation_sessions: [
      'title', 'status', 'version', 'last_message_at',
      'last_message_preview', 'message_count',
      'persona_profile_version', 'updated_at',
      'create_idempotency_key', 'create_payload_hash',
      'deletion_generation', 'deleted_at',
    ],
    conversation_turns: [
      'message_sequence', 'display_content', 'normalized_content',
      'message_status', 'client_message_id', 'message_payload_hash',
      'generation_group_id', 'variant_index', 'is_active_variant',
      'completed_at', 'message_version',
    ],
    persona_chat_profiles: [
      'id', 'principal_id', 'persona_id', 'profile_version',
      'display_name', 'system_prompt', 'greeting', 'language',
      'capability_ids_json', 'created_at', 'updated_at',
    ],
    conversation_message_actions: [
      'id', 'message_id', 'action_index', 'action_type',
      'payload_json', 'created_at',
    ],
    conversation_cursor_keys: [
      'key_version', 'secret', 'status', 'created_at', 'retired_at',
    ],
    conversation_project_bindings: [
      'principal_id', 'namespace', 'external_project_id',
      'display_name', 'status', 'version', 'created_at',
      'updated_at', 'last_seen_at',
    ],
    conversation_rounds: [
      'id', 'conversation_id', 'user_id', 'namespace',
      'client_message_id', 'request_payload_hash', 'user_message_id',
      'status', 'persona_profile_version_used',
      'active_assistant_message_id', 'current_attempt_id', 'generation',
      'failure_code', 'failure_message', 'failure_retryable',
      'failure_stage', 'request_id', 'created_at', 'updated_at',
      'completed_at',
    ],
    conversation_round_attempts: [
      'id', 'round_id', 'attempt_number', 'attempt_type', 'status',
      'lease_owner', 'lease_expires_at', 'heartbeat_at', 'request_id',
      'generation', 'failure_code', 'failure_message',
      'failure_retryable', 'failure_stage', 'started_at', 'updated_at',
      'ended_at',
    ],
    conversation_round_events: [
      'round_id', 'sequence', 'event_id', 'attempt_id', 'request_id',
      'event_type', 'data_json', 'contains_body', 'created_at',
      'expires_at',
    ],
    conversation_changes: [
      'sequence', 'user_id', 'namespace', 'event_type',
      'conversation_id', 'resource_id', 'resource_version',
      'occurred_at', 'tombstone', 'resource_json', 'expires_at',
    ],
    conversation_regeneration_requests: [
      'id', 'user_id', 'namespace', 'conversation_id', 'round_id',
      'client_request_id', 'source_assistant_message_id',
      'request_payload_hash', 'attempt_id', 'status',
      'new_assistant_message_id', 'failure_code', 'failure_message',
      'created_at', 'updated_at', 'completed_at',
    ],
    conversation_deletion_receipts: [
      'id', 'user_id', 'namespace', 'client_request_id',
      'resource_type', 'resource_id', 'conversation_id', 'memory_policy',
      'reason_hash', 'request_payload_hash', 'affected_message_ids_json',
      'memory_action_request_ids_json', 'cancelled_round_ids_json',
      'purge_job_id', 'created_at', 'completed_at',
    ],
    conversation_deletion_barriers: [
      'id', 'user_id', 'namespace', 'conversation_id', 'round_id',
      'resource_type', 'resource_id', 'generation', 'created_at',
      'expires_at',
    ],
    conversation_deleted_evidence_proofs: [
      'id', 'deletion_receipt_id', 'memory_version_id',
      'former_turn_hash', 'proof_type', 'created_at',
    ],
    conversation_memory_recomputations: [
      'id', 'deletion_receipt_id', 'memory_item_id', 'action', 'status',
      'remaining_evidence_count', 'new_memory_version_id',
      'last_error_code', 'created_at', 'updated_at', 'completed_at',
    ],
    conversation_maintenance_jobs: [
      'id', 'user_id', 'namespace', 'job_type', 'deletion_receipt_id',
      'payload_json', 'status', 'attempts', 'max_attempts',
      'available_at', 'lease_until', 'last_error_code', 'created_at',
      'updated_at', 'completed_at',
    ],
    conversation_import_states: [
      'user_id', 'namespace', 'import_id', 'lane', 'next_batch_index',
      'previous_payload_hash', 'completed', 'created_at', 'updated_at',
    ],
    conversation_import_receipts: [
      'id', 'user_id', 'namespace', 'import_id', 'lane', 'batch_index',
      'batch_cursor_in', 'payload_hash', 'batch_cursor_out',
      'is_last_batch', 'stats_json', 'created_at',
    ],
    conversation_import_sessions: [
      'user_id', 'namespace', 'import_id', 'external_session_id',
      'conversation_id', 'payload_hash', 'created_at',
    ],
    conversation_import_messages: [
      'user_id', 'namespace', 'import_id', 'external_session_id',
      'external_message_id', 'external_round_id', 'message_id',
      'payload_hash', 'created_at',
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const actual = new Set(
      (
        database
          .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
          .all() as Array<Record<string, unknown>>
      ).map((column) => String(column.name ?? '')),
    );
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length > 0) {
      throw new Error(
        `schema v32 conversation ${table} 字段缺失（` +
          `${missing.join(', ')}）。`,
      );
    }
  }
  const requiredIndexes = [
    'persona_chat_profiles_current_idx',
    'conversation_sessions_create_idempotency_idx',
    'conversation_sessions_product_list_idx',
    'conversation_turns_message_sequence_idx',
    'conversation_turns_client_message_idx',
    'conversation_message_actions_message_idx',
    'conversation_cursor_keys_one_current_idx',
    'conversation_project_bindings_list_idx',
    'conversation_rounds_client_message_idx',
    'conversation_rounds_single_flight_idx',
    'conversation_rounds_tenant_idx',
    'conversation_round_attempts_number_idx',
    'conversation_round_attempts_lease_idx',
    'conversation_round_events_sequence_idx',
    'conversation_round_events_expiry_idx',
    'conversation_changes_owner_sequence_idx',
    'conversation_changes_expiry_idx',
    'conversation_regeneration_request_idx',
    'conversation_turns_round_user_idx',
    'conversation_turns_generation_variant_idx',
    'conversation_turns_generation_active_idx',
    'conversation_deletion_receipts_owner_idx',
    'conversation_deletion_barriers_expiry_idx',
    'conversation_memory_recompute_status_idx',
    'conversation_maintenance_jobs_ready_idx',
    'conversation_import_receipts_owner_idx',
    'conversation_import_messages_round_idx',
  ];
  const indexes = new Set(
    (
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name IN (${requiredIndexes.map(() => '?').join(', ')})`,
        )
        .all(...requiredIndexes) as Array<Record<string, unknown>>
    ).map((row) => String(row.name ?? '')),
  );
  const missingIndexes = requiredIndexes.filter(
    (index) => !indexes.has(index),
  );
  if (missingIndexes.length > 0) {
    throw new Error(
        `schema v33 conversation 索引缺失（${missingIndexes.join(', ')}）。`,
      );
  }
  const conversationTriggers = [
    ...V32_CONVERSATION_TRIGGERS,
    ...V33_CONVERSATION_ROUND_TRIGGERS,
    ...V35_CONVERSATION_REGENERATION_TRIGGERS,
    ...V36_CONVERSATION_DELETION_TRIGGERS,
  ];
  const triggerNames = conversationTriggers.map(
    (trigger) => trigger.name,
  );
  const triggerRows = database
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name IN (${triggerNames.map(() => '?').join(', ')})`,
    )
    .all(...triggerNames) as Array<Record<string, unknown>>;
  const triggerByName = new Map(
    triggerRows.map((row) => [String(row.name ?? ''), row]),
  );
  const normalizeTriggerSql = (sql: string): string =>
    normalizeSchemaSql(sql).replace(
      /^create trigger if not exists /u,
      'create trigger ',
    );
  for (const expected of conversationTriggers) {
    const actual = triggerByName.get(expected.name);
    if (
      !actual ||
      String(actual.tbl_name ?? '') !== expected.table ||
      normalizeTriggerSql(String(actual.sql ?? '')) !==
        normalizeTriggerSql(expected.sql)
    ) {
      throw new Error(
        `schema v33 conversation 触发器缺失或定义不一致（` +
          `${expected.name}）。`,
      );
    }
  }
  const actionForeignKey = (
    database
      .prepare('PRAGMA foreign_key_list(conversation_message_actions)')
      .all() as Array<Record<string, unknown>>
  ).some(
    (foreignKey) =>
      foreignKey.from === 'message_id' &&
      foreignKey.table === 'conversation_turns' &&
      foreignKey.to === 'id' &&
      String(foreignKey.on_delete ?? '').toUpperCase() === 'CASCADE',
  );
  if (!actionForeignKey) {
    throw new Error('schema v32 conversation action 外键缺失。');
  }
  const invalidCursorKeys = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM conversation_cursor_keys
         WHERE length(secret) != 32
            OR status NOT IN ('current', 'previous')`,
      )
      .get()?.count || 0,
  );
  if (invalidCursorKeys > 0) {
    throw new Error('schema v33 conversation cursor key 结构无效。');
  }
  const invalidCurrentAttempts = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM conversation_rounds r
         LEFT JOIN conversation_round_attempts a
           ON a.id = r.current_attempt_id AND a.round_id = r.id
         WHERE r.current_attempt_id IS NOT NULL AND a.id IS NULL`,
      )
      .get()?.count || 0,
  );
  if (invalidCurrentAttempts > 0) {
    throw new Error('schema v33 conversation current attempt 引用无效。');
  }
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
             OR INSTR(COALESCE(display_content, ''), '<|') > 0
             OR INSTR(COALESCE(display_content, ''), '|>') > 0
             OR INSTR(
               LOWER(COALESCE(display_content, '')), '<tool_call'
             ) > 0
             OR INSTR(
               LOWER(COALESCE(display_content, '')), '<tool_result'
             ) > 0
             OR INSTR(
               COALESCE(display_content, ''),
               '[Memory Bridge 自动长期记忆上下文]'
             ) > 0
             OR INSTR(COALESCE(display_content, ''), '_memoryContext') > 0
           )`,
      )
      .get()?.count || 0,
  );
  if (contaminatedAssistantTurns > 0) {
    throw new Error(
      `schema v33 assistant protocol contamination（` +
        `${contaminatedAssistantTurns} 行）。`,
    );
  }
}

const LEGACY_SCOPE_TYPE_ENUM =
  "scope_type IN ('personal', 'project', 'role', 'session')";
const V44_SCOPE_TYPE_ENUM =
  "scope_type IN ('personal', 'project', 'role', 'session', 'public')";

// 公开通道（v44）：历史多租户迁移通过 ADD COLUMN / CREATE TABLE 把
// scope_type CHECK 写死为四种类型，public scope 写入会触发
// CHECK constraint failed。SQLite 无法修改 CHECK，按铁律
// 建新表→拷数据→换名。DDL 从 sqlite_master 派生、只改枚举文本，
// 命名索引与触发器在换名后按原定义逐字重建（保住各
// assert*Structure 对触发器定义的一致性断言）。
// 父表（memories/memory_items）被 DROP 时外键会做隐式全量 DELETE，
// 子表行会瞬时悬空——迁移在事务内无法关闭 foreign_keys，改用
// defer_foreign_keys 把校验推迟到 COMMIT：重建完成后行集不变，
// 提交时校验必然通过。
function rebuildScopeEnumTablesForPublicScope(database: DatabaseSync): void {
  const targets = database
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND sql IS NOT NULL AND instr(sql, ?) > 0`,
    )
    .all(LEGACY_SCOPE_TYPE_ENUM) as Array<{ name: string; sql: string }>;
  if (targets.length === 0) {
    return;
  }
  database.exec('PRAGMA defer_foreign_keys = ON;');
  // RENAME 期间旧表已删、新表未换名，其他表上引用本表的触发器会处于
  // "引用缺失表"状态；SQLite 默认在 RENAME 时全 schema 重解析并报错。
  // legacy_alter_table=ON 跳过重解析——子表外键与触发器本就按表名引用，
  // 换名后名字复原，语义正确。结束后恢复原值。
  const legacyAlterTableBefore = (
    database.prepare('PRAGMA legacy_alter_table').get() as {
      legacy_alter_table: number;
    }
  ).legacy_alter_table;
  database.exec('PRAGMA legacy_alter_table = ON;');
  try {
    for (const target of targets) {
      const tableName = target.name;
      const tempName = `${tableName}_v44_rebuild`;
      const createTempSql = target.sql
        .replaceAll(LEGACY_SCOPE_TYPE_ENUM, V44_SCOPE_TYPE_ENUM)
        .replace(
          new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?"?${tableName}"?`),
          `CREATE TABLE ${tempName}`,
        );
      if (!createTempSql.includes(tempName)) {
        throw new Error(
          `v44 迁移无法改写 ${tableName} 的建表语句（scope CHECK 枚举重建）`,
        );
      }
      const columnNames = (
        database
          .prepare('SELECT name FROM pragma_table_info(?)')
          .all(tableName) as Array<{ name: string }>
      ).map((row) => row.name);
      if (columnNames.length === 0) {
        throw new Error(`v44 迁移读取 ${tableName} 列清单失败`);
      }
      const indexAndTriggerSql = (
        database
          .prepare(
            `SELECT sql FROM sqlite_master
             WHERE tbl_name = ? AND type IN ('index', 'trigger')
               AND sql IS NOT NULL`,
          )
          .all(tableName) as Array<{ sql: string }>
      ).map((row) => row.sql);
      database.exec(createTempSql);
      const columnList = columnNames.join(', ');
      database.exec(
        `INSERT INTO ${tempName} (${columnList})
         SELECT ${columnList} FROM ${tableName}`,
      );
      database.exec(`DROP TABLE ${tableName}`);
      database.exec(`ALTER TABLE ${tempName} RENAME TO ${tableName}`);
      for (const sql of indexAndTriggerSql) {
        database.exec(sql);
      }
    }
  } finally {
    database.exec(`PRAGMA legacy_alter_table = ${legacyAlterTableBefore};`);
  }
}

function assertCurrentSchemaInvariants(database: DatabaseSync): void {
  assertCurrentProjectBindingStructure(database);
  assertIdentityImmutabilityTriggers(database);
  assertSchemaMigrationLedger(database);
  assertRetrievalObservabilityStructure(database);
  assertPrincipalScopedPersonaBindingStructure(database);
  assertReflectionStructure(database);
  assertConversationAuthorityStructure(database);
  assertLayeredMemoryStructure(database);
  assertMemoryEvidenceStructure(database);
}

function assertMemoryEvidenceStructure(database: DatabaseSync): void {
  if (!hasCurrentV39MemoryEvidenceTriggers(database)) {
    throw new Error(
      'schema v39 memory evidence 触发器缺失或定义不一致。',
    );
  }
  const invalidEvidenceRows = Number(database.prepare(
    `SELECT COUNT(*) AS count
     FROM memory_evidence e
     LEFT JOIN memory_versions v ON v.id = e.memory_version_id
     LEFT JOIN memory_items i ON i.id = v.memory_item_id
     LEFT JOIN memories m ON m.id = i.id
     LEFT JOIN conversation_turns t ON t.id = e.turn_id
     LEFT JOIN conversation_sessions s ON s.id = t.session_id
     WHERE v.id IS NULL OR i.id IS NULL OR m.id IS NULL
        OR m.user_id != i.user_id OR m.namespace != i.namespace
        OR (
          e.turn_id IS NOT NULL
          AND (
            t.id IS NULL OR s.id IS NULL
            OR t.user_id != i.user_id OR t.namespace != i.namespace
            OR s.user_id != i.user_id OR s.namespace != i.namespace
            OR NOT (
              (v.scope_type = 'personal' AND v.scope_key = 'self')
              OR (v.scope_type = 'role' AND s.persona_id = v.scope_key)
              OR (v.scope_type = 'project' AND s.project_id = v.scope_key)
              OR (v.scope_type = 'session' AND s.external_id = v.scope_key)
            )
          )
        )`,
  ).get()?.count || 0);
  if (invalidEvidenceRows > 0) {
    throw new Error(
      `schema v39 memory evidence owner/scope 校验失败（` +
        `${invalidEvidenceRows} 行）。`,
    );
  }
}

function assertLayeredMemoryStructure(database: DatabaseSync): void {
  const requiredTables = [
    'conversation_episodes',
    'conversation_episode_turns',
    'memory_pattern_observations',
    'conversation_memory_summaries',
    'conversation_memory_summary_sources',
    'conversation_episode_compactions',
  ];
  const observed = new Set(
    (database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN (${requiredTables.map(() => '?').join(', ')})`,
    ).all(...requiredTables) as Array<Record<string, unknown>>)
      .map((row) => String(row.name ?? '')),
  );
  const missing = requiredTables.filter((table) => !observed.has(table));
  if (missing.length > 0) {
    throw new Error(
      `schema v38 layered memory 表缺失（${missing.join(', ')}）。`,
    );
  }
  const requiredIndexes = [
    'conversation_episodes_owner_time_idx',
    'conversation_episode_turns_turn_idx',
    'memory_pattern_observations_claim_idx',
    'conversation_memory_summaries_scope_idx',
    'conversation_memory_summary_sources_source_idx',
    'conversation_episode_compactions_owner_idx',
    'memory_evidence_turn_version_idx',
  ];
  const indexes = new Set(
    (database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name IN (${requiredIndexes.map(() => '?').join(', ')})`,
    ).all(...requiredIndexes) as Array<Record<string, unknown>>)
      .map((row) => String(row.name ?? '')),
  );
  const missingIndexes = requiredIndexes.filter(
    (index) => !indexes.has(index),
  );
  if (missingIndexes.length > 0) {
    throw new Error(
      `schema v38 layered memory 索引缺失（${missingIndexes.join(', ')}）。`,
    );
  }
  const consolidationTrigger = database.prepare(
    `SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'memory_event_consolidation_job'`,
  ).get();
  const triggerSql = normalizeSchemaSql(
    String(consolidationTrigger?.sql ?? ''),
  );
  for (const excludedSource of [
    'conversation_episode',
    'hierarchical_summary',
    'consolidation',
  ]) {
    if (!triggerSql.includes(`'${excludedSource}'`)) {
      throw new Error(
        `schema v38 consolidation trigger 未排除 ${excludedSource}。`,
      );
    }
  }
  if (!triggerSql.includes('coalesced_by_newer_memory_event')) {
    throw new Error('schema v38 consolidation trigger 缺少待处理任务合并。');
  }
  const orphanedEpisodes = Number(database.prepare(
    `SELECT COUNT(*) AS count
     FROM conversation_episodes e
     LEFT JOIN memories m ON m.id = e.memory_id
     LEFT JOIN conversation_turns u ON u.id = e.user_turn_id
     LEFT JOIN conversation_turns a ON a.id = e.assistant_turn_id
     WHERE m.id IS NULL OR u.id IS NULL OR a.id IS NULL
        OR m.user_id != e.user_id OR m.namespace != e.namespace
        OR u.user_id != e.user_id OR u.namespace != e.namespace
        OR a.user_id != e.user_id OR a.namespace != e.namespace
        OR u.session_id != e.session_id OR a.session_id != e.session_id
        OR u.role != 'user' OR a.role != 'assistant'`,
  ).get()?.count || 0);
  if (orphanedEpisodes > 0) {
    throw new Error(
      `schema v37 layered memory 情景引用无效（${orphanedEpisodes} 行）。`,
    );
  }
}

function ensureV26SchemaAttestation(database: DatabaseSync): void {
  assertCurrentProjectBindingStructure(database);
  if (!hasSchemaMigrationLedger(database)) {
    assertNoLegacyProjectScopes(database);
    installIdentityImmutabilityTriggers(database);
    createSchemaMigrationLedger(database);
    recordV26CurrentSchemaAttestation(
      database,
      IDENTITY_SCHEMA_VERSION,
      'safe_no_project_adoption',
    );
  } else {
    const attestation = assertSchemaMigrationLedger(database, true);
    if (attestation.generation === 'v1') {
      installIdentityImmutabilityTriggers(database);
      replaceV26SchemaAttestation(database, attestation);
    } else {
      assertIdentityImmutabilityTriggers(database);
    }
  }
  assertCurrentProjectBindingStructure(database);
  assertIdentityImmutabilityTriggers(database);
  assertSchemaMigrationLedger(database);
}

function migrate(
  database: DatabaseSync,
  filePath: string,
  options: OpenDatabaseOptions,
): void {
  const observedVersion = schemaVersion(database);
  assertSupportedSchemaVersion(observedVersion);
  if (
    observedVersion === SCHEMA_VERSION &&
    hasCurrentV26SchemaAttestation(database) &&
    hasCurrentV38ConsolidationTrigger(database) &&
    hasCurrentV39MemoryEvidenceTriggers(database) &&
    Boolean(database.prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'index' AND name = 'memory_evidence_turn_version_idx'`,
    ).get())
  ) {
    assertCurrentSchemaInvariants(database);
    return;
  }

  // 迁移备份必须在 BEGIN IMMEDIATE 之前完成：node:sqlite 下第二连接的
  // VACUUM INTO 在主连接持有写事务时会抛 SQLITE_IOERR（disk I/O error）。
  // openDatabase 冷启动场景没有并发写者，先备份再取锁语义等价。
  const preLockBackupCreated = backupBeforeMigration(
    filePath,
    schemaVersion(database),
  );
  if (preLockBackupCreated) options.testOnlyAfterMigrationBackup?.();

  withSqliteBusyRetry(
    () => database.exec('BEGIN IMMEDIATE'),
    {
      operation: 'acquire schema migration write lock',
      maxAttempts: 8,
      totalBudgetMs: 15_000,
    },
  );
  try {
    let version = schemaVersion(database);
    assertSupportedSchemaVersion(version);
    if (version === SCHEMA_VERSION) {
      ensureV26SchemaAttestation(database);
      database.exec(V37_MEMORY_EVIDENCE_TURN_INDEX);
      database.exec('DROP TRIGGER IF EXISTS memory_event_consolidation_job;');
      database.exec(V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER);
      installV39MemoryEvidenceTriggers(database);
      assertCurrentSchemaInvariants(database);
      database.exec('COMMIT');
      return;
    }
    const fromVersion = version;
    for (const trigger of V32_CONVERSATION_TRIGGERS) {
      database.exec(
        `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)};`,
      );
    }
    for (const trigger of V33_CONVERSATION_ROUND_TRIGGERS) {
      database.exec(
        `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)};`,
      );
    }
    for (const trigger of V35_CONVERSATION_REGENERATION_TRIGGERS) {
      database.exec(
        `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)};`,
      );
    }
    for (const trigger of V36_CONVERSATION_DELETION_TRIGGERS) {
      database.exec(
        `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)};`,
      );
    }
    if (version < 1) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
        confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'mcp',
        source_ref TEXT,
        occurred_at TEXT,
        valid_from TEXT,
        valid_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        checksum TEXT NOT NULL,
        embedding BLOB NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS memories_scope_idx
        ON memories(user_id, namespace, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_kind_idx
        ON memories(user_id, kind, status);
      CREATE INDEX IF NOT EXISTS memories_checksum_idx
        ON memories(user_id, namespace, checksum);

      CREATE TABLE IF NOT EXISTS memory_relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        to_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(from_memory_id, to_memory_id, relation_type)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        memory_id TEXT,
        user_id TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_created_idx
        ON audit_log(created_at DESC);

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      PRAGMA user_version = 1;
      `);
      version = 1;
    }

    if (version < 2) {
      database.exec(`
      CREATE TABLE idempotency_keys_v2 (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, namespace, key)
      );

      INSERT INTO idempotency_keys_v2 (
        user_id, namespace, key, memory_id, created_at
      )
      SELECT m.user_id, m.namespace, i.key, i.memory_id, i.created_at
      FROM idempotency_keys i
      JOIN memories m ON m.id = i.memory_id;

      DROP TABLE idempotency_keys;
      ALTER TABLE idempotency_keys_v2 RENAME TO idempotency_keys;

      CREATE INDEX idempotency_memory_idx
        ON idempotency_keys(memory_id);

      PRAGMA user_version = 2;
      `);
      version = 2;
    }

    if (version < 3) {
      database.exec(`
      CREATE TABLE audit_log_v3 (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id INTEGER NOT NULL,
        action TEXT NOT NULL,
        memory_id TEXT,
        user_id TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(user_id, id)
      );

      INSERT INTO audit_log_v3 (
        id, action, memory_id, user_id, detail_json, created_at
      )
      SELECT id, action, memory_id, user_id, detail_json, created_at
      FROM audit_log;

      DROP TABLE audit_log;
      ALTER TABLE audit_log_v3 RENAME TO audit_log;

      CREATE INDEX audit_created_idx
        ON audit_log(created_at DESC);
      CREATE INDEX audit_user_idx
        ON audit_log(user_id, id DESC);

      PRAGMA user_version = 3;
      `);
      version = 3;
    }

    if (version < 4) {
      database.exec(`
      CREATE TABLE memory_embeddings (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        embedding BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, model)
      );

      CREATE INDEX memory_embeddings_model_idx
        ON memory_embeddings(model, updated_at DESC);

      PRAGMA user_version = 4;
      `);
      version = 4;
    }

    if (version < 5) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        client_name TEXT NOT NULL,
        external_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(user_id, client_name, external_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_sessions_user_idx
        ON conversation_sessions(user_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        external_id TEXT NOT NULL,
        role TEXT NOT NULL
          CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(session_id, external_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_turns_session_idx
        ON conversation_turns(session_id, occurred_at ASC);
      CREATE INDEX IF NOT EXISTS conversation_turns_user_idx
        ON conversation_turns(user_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS conversation_turns_hash_idx
        ON conversation_turns(user_id, content_hash);

      CREATE TABLE IF NOT EXISTS extraction_runs (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(turn_id, model, prompt_version)
      );

      CREATE INDEX IF NOT EXISTS extraction_runs_status_idx
        ON extraction_runs(status, created_at ASC);

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        turn_id TEXT
          REFERENCES conversation_turns(id) ON DELETE SET NULL,
        extraction_run_id TEXT
          REFERENCES extraction_runs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value_text TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        normalized_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL
          CHECK (confidence >= 0 AND confidence <= 1),
        importance REAL NOT NULL
          CHECK (importance >= 0 AND importance <= 1),
        sensitivity TEXT NOT NULL DEFAULT 'normal'
          CHECK (sensitivity IN ('normal', 'sensitive', 'credential')),
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN (
            'pending', 'accepted', 'rejected', 'conflicted'
          )),
        decision_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(extraction_run_id, normalized_hash)
      );

      CREATE INDEX IF NOT EXISTS memory_candidates_inbox_idx
        ON memory_candidates(user_id, state, created_at DESC);
      CREATE INDEX IF NOT EXISTS memory_candidates_key_idx
        ON memory_candidates(user_id, namespace, normalized_key);

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        kind TEXT NOT NULL,
        stable_key TEXT NOT NULL,
        current_version_id TEXT,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN (
            'active', 'superseded', 'archived', 'deleted', 'conflicted'
          )),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, stable_key)
      );

      CREATE INDEX IF NOT EXISTS memory_items_scope_idx
        ON memory_items(user_id, namespace, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memory_items_kind_idx
        ON memory_items(user_id, kind, status);

      CREATE TABLE IF NOT EXISTS memory_versions (
        id TEXT PRIMARY KEY,
        memory_item_id TEXT NOT NULL
          REFERENCES memory_items(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL
          CHECK (importance >= 0 AND importance <= 1),
        confidence REAL NOT NULL
          CHECK (confidence >= 0 AND confidence <= 1),
        source TEXT NOT NULL,
        source_ref TEXT,
        occurred_at TEXT,
        valid_from TEXT,
        valid_to TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(memory_item_id, version)
      );

      CREATE INDEX IF NOT EXISTS memory_versions_item_idx
        ON memory_versions(memory_item_id, version DESC);

      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        memory_version_id TEXT NOT NULL
          REFERENCES memory_versions(id) ON DELETE CASCADE,
        turn_id TEXT
          REFERENCES conversation_turns(id) ON DELETE SET NULL,
        evidence_type TEXT NOT NULL,
        excerpt TEXT,
        source_ref TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_evidence_version_idx
        ON memory_evidence(memory_version_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_evidence_turn_version_idx
        ON memory_evidence(turn_id, memory_version_id);

      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        from_memory_item_id TEXT NOT NULL
          REFERENCES memory_items(id) ON DELETE CASCADE,
        to_memory_item_id TEXT NOT NULL
          REFERENCES memory_items(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(
          from_memory_item_id,
          to_memory_item_id,
          relation_type
        )
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_item_id TEXT
          REFERENCES memory_items(id) ON DELETE SET NULL,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_events_user_idx
        ON memory_events(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS outbox_events (
        id TEXT PRIMARY KEY,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        UNIQUE(aggregate_type, aggregate_id, event_type)
      );

      CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
        ON outbox_events(status, available_at ASC);

      CREATE TABLE IF NOT EXISTS memory_jobs (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending', 'running', 'completed', 'failed', 'dead'
          )),
        priority INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_jobs_ready_idx
        ON memory_jobs(status, priority DESC, available_at ASC);

      CREATE TABLE IF NOT EXISTS dead_letter_jobs (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT NOT NULL,
        failed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retention_policies (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        kind TEXT,
        evidence_ttl_days INTEGER,
        half_life_days INTEGER,
        auto_archive INTEGER NOT NULL DEFAULT 1
          CHECK (auto_archive IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, kind)
      );

      CREATE TABLE IF NOT EXISTS memory_tombstones (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        stable_key TEXT,
        content_hash TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        restored_at TEXT,
        CHECK (stable_key IS NOT NULL OR content_hash IS NOT NULL)
      );

      CREATE INDEX IF NOT EXISTS memory_tombstones_lookup_idx
        ON memory_tombstones(
          user_id,
          namespace,
          stable_key,
          content_hash,
          restored_at
        );

      INSERT OR IGNORE INTO memory_items (
        id, user_id, namespace, kind, stable_key, current_version_id,
        status, revision, created_at, updated_at
      )
      SELECT
        id, user_id, namespace, kind, 'legacy:' || id, id || ':v1',
        status, 1, created_at, updated_at
      FROM memories;

      INSERT OR IGNORE INTO memory_versions (
        id, memory_item_id, version, title, content, summary, tags_json,
        importance, confidence, source, source_ref, occurred_at,
        valid_from, valid_to, created_by, created_at
      )
      SELECT
        id || ':v1', id, 1, title, content, summary, tags_json,
        importance, confidence, source, source_ref, occurred_at,
        valid_from, valid_to, 'legacy-migration', created_at
      FROM memories;

      INSERT OR IGNORE INTO memory_edges (
        id, from_memory_item_id, to_memory_item_id, relation_type,
        created_at
      )
      SELECT
        'legacy-relation:' || id,
        from_memory_id,
        to_memory_id,
        relation_type,
        created_at
      FROM memory_relations;

      INSERT OR IGNORE INTO memory_events (
        id, memory_item_id, user_id, event_type, payload_json, created_at
      )
      SELECT
        id || ':event:v1',
        id,
        user_id,
        'legacy_imported',
        '{"source":"memories"}',
        created_at
      FROM memories;

      PRAGMA user_version = 5;
      `);
      version = 5;
    }

    if (version < 6) {
      addColumnIfMissing(
        database,
        'memory_candidates',
        'explicit_correction',
        `ALTER TABLE memory_candidates
         ADD COLUMN explicit_correction INTEGER NOT NULL DEFAULT 0
           CHECK (explicit_correction IN (0, 1))`,
      );
      addColumnIfMissing(
        database,
        'memory_candidates',
        'resolved_memory_item_id',
        `ALTER TABLE memory_candidates
         ADD COLUMN resolved_memory_item_id TEXT
           REFERENCES memory_items(id) ON DELETE SET NULL`,
      );
      addColumnIfMissing(
        database,
        'memory_candidates',
        'resolved_at',
        `ALTER TABLE memory_candidates
         ADD COLUMN resolved_at TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'predicate_key',
        `ALTER TABLE memory_items
         ADD COLUMN predicate_key TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'normalized_value_hash',
        `ALTER TABLE memory_items
         ADD COLUMN normalized_value_hash TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'normalized_value',
        `ALTER TABLE memory_items
         ADD COLUMN normalized_value TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'predicate_cardinality',
        `ALTER TABLE memory_items
         ADD COLUMN predicate_cardinality TEXT NOT NULL DEFAULT 'single'
           CHECK (predicate_cardinality IN ('single', 'set', 'event'))`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'observation_count',
        `ALTER TABLE memory_items
         ADD COLUMN observation_count INTEGER NOT NULL DEFAULT 1
           CHECK (observation_count > 0)`,
      );
      addColumnIfMissing(
        database,
        'memory_versions',
        'superseded_at',
        `ALTER TABLE memory_versions
         ADD COLUMN superseded_at TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_versions',
        'predicate_key',
        `ALTER TABLE memory_versions
         ADD COLUMN predicate_key TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_versions',
        'namespace',
        `ALTER TABLE memory_versions
         ADD COLUMN namespace TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_versions',
        'kind',
        `ALTER TABLE memory_versions
         ADD COLUMN kind TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_versions',
        'normalized_value_hash',
        `ALTER TABLE memory_versions
         ADD COLUMN normalized_value_hash TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_versions',
        'normalized_value',
        `ALTER TABLE memory_versions
         ADD COLUMN normalized_value TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_versions',
        'predicate_cardinality',
        `ALTER TABLE memory_versions
         ADD COLUMN predicate_cardinality TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_jobs',
        'lease_owner',
        `ALTER TABLE memory_jobs
         ADD COLUMN lease_owner TEXT`,
      );
      database.exec(`
      UPDATE memory_items
      SET predicate_key = stable_key
      WHERE predicate_key IS NULL;

      UPDATE memory_versions
      SET
        namespace = COALESCE(
          namespace,
          (
            SELECT namespace
            FROM memory_items
            WHERE memory_items.id = memory_versions.memory_item_id
          )
        ),
        kind = COALESCE(
          kind,
          (
            SELECT kind
            FROM memory_items
            WHERE memory_items.id = memory_versions.memory_item_id
          )
        );

      CREATE INDEX IF NOT EXISTS memory_items_predicate_idx
        ON memory_items(
          user_id,
          namespace,
          predicate_key,
          status,
          updated_at DESC
        );
      CREATE INDEX IF NOT EXISTS memory_items_value_idx
        ON memory_items(
          user_id,
          namespace,
          predicate_key,
          normalized_value_hash
        );
      CREATE INDEX IF NOT EXISTS memory_candidates_resolution_idx
        ON memory_candidates(state, resolved_at, created_at ASC);

      PRAGMA user_version = 6;
      `);
      version = 6;
    }

    if (version < 7) {
      database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(
        memory_id UNINDEXED,
        user_id UNINDEXED,
        namespace UNINDEXED,
        kind UNINDEXED,
        title,
        content,
        summary,
        tags,
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS memories_fts_insert
      AFTER INSERT ON memories
      BEGIN
        INSERT INTO memories_fts (
          memory_id, user_id, namespace, kind,
          title, content, summary, tags
        ) VALUES (
          new.id, new.user_id, new.namespace, new.kind,
          new.title, new.content, new.summary, new.tags_json
        );
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_update
      AFTER UPDATE ON memories
      BEGIN
        DELETE FROM memories_fts WHERE memory_id = old.id;
        INSERT INTO memories_fts (
          memory_id, user_id, namespace, kind,
          title, content, summary, tags
        ) VALUES (
          new.id, new.user_id, new.namespace, new.kind,
          new.title, new.content, new.summary, new.tags_json
        );
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_delete
      AFTER DELETE ON memories
      BEGIN
        DELETE FROM memories_fts WHERE memory_id = old.id;
      END;

      DELETE FROM memories_fts;
      INSERT INTO memories_fts (
        memory_id, user_id, namespace, kind,
        title, content, summary, tags
      )
      SELECT
        id, user_id, namespace, kind,
        title, content, summary, tags_json
      FROM memories;

      CREATE TABLE IF NOT EXISTS memory_ann_index (
        memory_id TEXT NOT NULL
          REFERENCES memories(id) ON DELETE CASCADE,
        index_model TEXT NOT NULL,
        band INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, index_model, band)
      );

      CREATE INDEX IF NOT EXISTS memory_ann_bucket_idx
        ON memory_ann_index(index_model, band, bucket, memory_id);

      PRAGMA user_version = 7;
      `);
      version = 7;
    }

    if (version < 8) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS memory_term_index (
        memory_id TEXT NOT NULL
          REFERENCES memories(id) ON DELETE CASCADE,
        index_model TEXT NOT NULL,
        term TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(memory_id, index_model, term)
      );

      CREATE INDEX IF NOT EXISTS memory_term_lookup_idx
        ON memory_term_index(index_model, term, memory_id);

      PRAGMA user_version = 8;
      `);
      version = 8;
    }

    if (version < 9) {
      addColumnIfMissing(
        database,
        'memory_items',
        'pinned',
        `ALTER TABLE memory_items
         ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0
           CHECK (pinned IN (0, 1))`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'expires_at',
        `ALTER TABLE memory_items
         ADD COLUMN expires_at TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'archived_at',
        `ALTER TABLE memory_items
         ADD COLUMN archived_at TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'archive_reason',
        `ALTER TABLE memory_items
         ADD COLUMN archive_reason TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'retrieved_count',
        `ALTER TABLE memory_items
         ADD COLUMN retrieved_count INTEGER NOT NULL DEFAULT 0
           CHECK (retrieved_count >= 0)`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'used_count',
        `ALTER TABLE memory_items
         ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0
           CHECK (used_count >= 0)`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'confirmed_count',
        `ALTER TABLE memory_items
         ADD COLUMN confirmed_count INTEGER NOT NULL DEFAULT 0
           CHECK (confirmed_count >= 0)`,
      );
      addColumnIfMissing(
        database,
        'memory_items',
        'rejected_count',
        `ALTER TABLE memory_items
         ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0
           CHECK (rejected_count >= 0)`,
      );
      database.exec(`
      CREATE INDEX IF NOT EXISTS memory_items_retention_idx
        ON memory_items(
          user_id,
          namespace,
          status,
          pinned,
          expires_at,
          updated_at
        );

      CREATE TABLE IF NOT EXISTS derived_consolidations (
        id TEXT PRIMARY KEY,
        memory_id TEXT
          REFERENCES memories(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('session', 'topic', 'person', 'project')),
        scope_key TEXT NOT NULL,
        source_set_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('active', 'stale', 'quarantined')),
        generated_at TEXT NOT NULL,
        stale_at TEXT,
        last_error TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        UNIQUE(memory_id),
        UNIQUE(
          user_id,
          namespace,
          scope_type,
          scope_key,
          source_set_hash,
          model,
          prompt_version
        )
      );

      CREATE INDEX IF NOT EXISTS derived_consolidations_scope_idx
        ON derived_consolidations(
          user_id,
          namespace,
          scope_type,
          scope_key,
          status,
          generated_at DESC
        );

      CREATE TABLE IF NOT EXISTS derived_consolidation_sources (
        consolidation_id TEXT NOT NULL
          REFERENCES derived_consolidations(id) ON DELETE CASCADE,
        memory_version_id TEXT NOT NULL
          REFERENCES memory_versions(id) ON DELETE CASCADE,
        PRIMARY KEY(consolidation_id, memory_version_id)
      );

      CREATE INDEX IF NOT EXISTS derived_sources_version_idx
        ON derived_consolidation_sources(
          memory_version_id,
          consolidation_id
        );

      CREATE TABLE IF NOT EXISTS derived_consolidation_sentences (
        id TEXT PRIMARY KEY,
        consolidation_id TEXT NOT NULL
          REFERENCES derived_consolidations(id) ON DELETE CASCADE,
        sentence_index INTEGER NOT NULL CHECK (sentence_index >= 0),
        sentence_text TEXT NOT NULL,
        supported INTEGER NOT NULL DEFAULT 1
          CHECK (supported IN (0, 1)),
        UNIQUE(consolidation_id, sentence_index)
      );

      CREATE TABLE IF NOT EXISTS derived_sentence_sources (
        sentence_id TEXT NOT NULL
          REFERENCES derived_consolidation_sentences(id)
          ON DELETE CASCADE,
        memory_version_id TEXT NOT NULL
          REFERENCES memory_versions(id) ON DELETE CASCADE,
        PRIMARY KEY(sentence_id, memory_version_id)
      );

      CREATE INDEX IF NOT EXISTS derived_sentence_source_version_idx
        ON derived_sentence_sources(memory_version_id, sentence_id);

      CREATE TABLE IF NOT EXISTS purge_jobs (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending', 'running', 'completed', 'failed', 'dead'
          )),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        lease_until TEXT,
        lease_owner TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS purge_jobs_ready_idx
        ON purge_jobs(status, available_at ASC);

      CREATE TRIGGER IF NOT EXISTS memory_event_consolidation_job
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
      BEGIN
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

      PRAGMA user_version = 9;
      `);
      version = 9;
    }

    if (version < 10) {
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
      version = 10;
    }

    if (version < 11) {
      addColumnIfMissing(
        database,
        'outbox_events',
        'lease_owner',
        `ALTER TABLE outbox_events
         ADD COLUMN lease_owner TEXT`,
      );
      addColumnIfMissing(
        database,
        'outbox_events',
        'max_attempts',
        `ALTER TABLE outbox_events
         ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 10
           CHECK (max_attempts > 0)`,
      );
      addColumnIfMissing(
        database,
        'outbox_events',
        'updated_at',
        `ALTER TABLE outbox_events
         ADD COLUMN updated_at TEXT`,
      );
      database.exec(`
      UPDATE outbox_events
      SET updated_at = COALESCE(updated_at, created_at);

      CREATE INDEX IF NOT EXISTS outbox_events_lease_idx
        ON outbox_events(status, lease_until, available_at);

      PRAGMA user_version = 11;
      `);
      version = 11;
    }

    if (version < 12) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS memory_dense_lsh (
        memory_id TEXT NOT NULL
          REFERENCES memories(id) ON DELETE CASCADE,
        embedding_model TEXT NOT NULL,
        index_version TEXT NOT NULL,
        band INTEGER NOT NULL CHECK (band >= 0),
        bucket TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(
          memory_id,
          embedding_model,
          index_version,
          band
        )
      );

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_bucket_idx
        ON memory_dense_lsh(
          embedding_model,
          index_version,
          band,
          bucket,
          memory_id
        );

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_watermark_idx
        ON memory_dense_lsh(
          embedding_model,
          index_version,
          updated_at,
          memory_id
        );

      PRAGMA user_version = 12;
      `);
      version = 12;
    }

    if (version < 13) {
      addColumnIfMissing(
        database,
        'memory_dense_lsh',
        'dimensions',
        `ALTER TABLE memory_dense_lsh
         ADD COLUMN dimensions INTEGER`,
      );
      database.exec(`
      UPDATE memory_dense_lsh
      SET dimensions = (
        SELECT e.dimensions
        FROM memory_embeddings e
        WHERE e.memory_id = memory_dense_lsh.memory_id
          AND e.model = memory_dense_lsh.embedding_model
          AND e.text_hash = memory_dense_lsh.text_hash
      )
      WHERE dimensions IS NULL;

      CREATE TABLE IF NOT EXISTS dense_index_state (
        embedding_model TEXT NOT NULL,
        index_version TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        probed_at TEXT NOT NULL,
        PRIMARY KEY(embedding_model, index_version)
      );

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_generation_idx
        ON memory_dense_lsh(
          embedding_model,
          index_version,
          dimensions,
          updated_at,
          memory_id
        );

      PRAGMA user_version = 13;
      `);
      version = 13;
    }

    if (version < 14) {
      addColumnIfMissing(
        database,
        'memory_embeddings',
        'generation_key',
        `ALTER TABLE memory_embeddings
         ADD COLUMN generation_key TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_dense_lsh',
        'generation_key',
        `ALTER TABLE memory_dense_lsh
         ADD COLUMN generation_key TEXT`,
      );
      addColumnIfMissing(
        database,
        'dense_index_state',
        'generation_key',
        `ALTER TABLE dense_index_state
         ADD COLUMN generation_key TEXT`,
      );
      database.exec(`
      UPDATE memory_dense_lsh
      SET generation_key = 'legacy-unknown'
      WHERE generation_key IS NULL;

      UPDATE memory_embeddings
      SET generation_key = 'legacy-unknown'
      WHERE generation_key IS NULL;

      UPDATE dense_index_state
      SET generation_key = 'legacy-unknown'
      WHERE generation_key IS NULL;

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_generation_key_idx
        ON memory_dense_lsh(
          embedding_model,
          index_version,
          generation_key,
          dimensions,
          band,
          bucket,
          memory_id
        );

      PRAGMA user_version = 14;
      `);
      version = 14;
    }

    if (version < 15) {
      addColumnIfMissing(
        database,
        'memories',
        'semantic_revision',
        `ALTER TABLE memories
         ADD COLUMN semantic_revision INTEGER NOT NULL DEFAULT 1
           CHECK (semantic_revision > 0)`,
      );
      addColumnIfMissing(
        database,
        'memory_embeddings',
        'memory_revision',
        `ALTER TABLE memory_embeddings
         ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 1
           CHECK (memory_revision > 0)`,
      );
      addColumnIfMissing(
        database,
        'memory_dense_lsh',
        'memory_revision',
        `ALTER TABLE memory_dense_lsh
         ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 1
           CHECK (memory_revision > 0)`,
      );
      database.exec(`
      UPDATE memory_embeddings
      SET memory_revision = COALESCE(
        (
          SELECT m.semantic_revision
          FROM memories m
          WHERE m.id = memory_embeddings.memory_id
        ),
        1
      );

      UPDATE memory_dense_lsh
      SET memory_revision = COALESCE(
        (
          SELECT m.semantic_revision
          FROM memories m
          WHERE m.id = memory_dense_lsh.memory_id
        ),
        1
      );

      DROP TRIGGER IF EXISTS memories_semantic_revision_au;
      CREATE TRIGGER memories_semantic_revision_au
      AFTER UPDATE OF title, content, summary, tags_json ON memories
      FOR EACH ROW
      BEGIN
        UPDATE memories
        SET semantic_revision = OLD.semantic_revision + 1
        WHERE id = NEW.id;
      END;

      CREATE INDEX IF NOT EXISTS memory_dense_lsh_revision_idx
        ON memory_dense_lsh(
          memory_id,
          embedding_model,
          index_version,
          dimensions,
          generation_key,
          memory_revision,
          band
        );

      PRAGMA user_version = 15;
      `);
      version = 15;
    }

    if (version < 16) {
      addColumnIfMissing(
        database,
        'memory_candidates',
        'negated',
        `ALTER TABLE memory_candidates
         ADD COLUMN negated INTEGER NOT NULL DEFAULT 0
           CHECK (negated IN (0, 1))`,
      );
      addColumnIfMissing(
        database,
        'memory_candidates',
        'scope_type',
        `ALTER TABLE memory_candidates
         ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'
           CHECK (scope_type IN ('personal', 'project', 'role', 'session'))`,
      );
      addColumnIfMissing(
        database,
        'memory_candidates',
        'scope_key',
        `ALTER TABLE memory_candidates
         ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`,
      );
      for (const [column, sql] of [
        ['claim_occurred_at', `ALTER TABLE memory_candidates
          ADD COLUMN claim_occurred_at TEXT`],
        ['claim_valid_from', `ALTER TABLE memory_candidates
          ADD COLUMN claim_valid_from TEXT`],
        ['claim_valid_to', `ALTER TABLE memory_candidates
          ADD COLUMN claim_valid_to TEXT`],
        ['source_excerpt', `ALTER TABLE memory_candidates
          ADD COLUMN source_excerpt TEXT`],
        ['extractor_id', `ALTER TABLE memory_candidates
          ADD COLUMN extractor_id TEXT NOT NULL DEFAULT 'legacy'`],
        ['extractor_version', `ALTER TABLE memory_candidates
          ADD COLUMN extractor_version TEXT NOT NULL DEFAULT 'v1'`],
        ['extraction_model', `ALTER TABLE memory_candidates
          ADD COLUMN extraction_model TEXT NOT NULL DEFAULT 'unknown'`],
        ['extraction_prompt_version', `ALTER TABLE memory_candidates
          ADD COLUMN extraction_prompt_version TEXT NOT NULL DEFAULT 'unknown'`],
      ] as const) {
        addColumnIfMissing(
          database,
          'memory_candidates',
          column,
          sql,
        );
      }
      addColumnIfMissing(
        database,
        'memory_candidates',
        'source_authority',
        `ALTER TABLE memory_candidates
         ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'legacy_unknown'
           CHECK (source_authority IN (
             'direct_user', 'user_confirmed', 'assistant_inference',
             'imported', 'legacy_unknown'
           ))`,
      );

      for (const table of ['memories', 'memory_items'] as const) {
        addColumnIfMissing(
          database,
          table,
          'scope_type',
          `ALTER TABLE ${table}
           ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'
             CHECK (scope_type IN ('personal', 'project', 'role', 'session'))`,
        );
        addColumnIfMissing(
          database,
          table,
          'scope_key',
          `ALTER TABLE ${table}
           ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`,
        );
        addColumnIfMissing(
          database,
          table,
          'sensitivity',
          `ALTER TABLE ${table}
           ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
             CHECK (sensitivity IN ('normal', 'sensitive', 'credential'))`,
        );
        addColumnIfMissing(
          database,
          table,
          'source_authority',
          `ALTER TABLE ${table}
           ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'legacy_unknown'
             CHECK (source_authority IN (
               'direct_user', 'user_confirmed', 'assistant_inference',
               'imported', 'legacy_unknown'
             ))`,
        );
      }
      addColumnIfMissing(
        database,
        'memories',
        'negated',
        `ALTER TABLE memories
         ADD COLUMN negated INTEGER NOT NULL DEFAULT 0
           CHECK (negated IN (0, 1))`,
      );

      for (const [column, sql] of [
        ['scope_type', `ALTER TABLE memory_versions
          ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'
            CHECK (scope_type IN ('personal', 'project', 'role', 'session'))`],
        ['scope_key', `ALTER TABLE memory_versions
          ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`],
        ['sensitivity', `ALTER TABLE memory_versions
          ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
            CHECK (sensitivity IN ('normal', 'sensitive', 'credential'))`],
        ['source_authority', `ALTER TABLE memory_versions
          ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'legacy_unknown'
            CHECK (source_authority IN (
              'direct_user', 'user_confirmed', 'assistant_inference',
              'imported', 'legacy_unknown'
            ))`],
        ['negated', `ALTER TABLE memory_versions
          ADD COLUMN negated INTEGER NOT NULL DEFAULT 0
            CHECK (negated IN (0, 1))`],
      ] as const) {
        addColumnIfMissing(
          database,
          'memory_versions',
          column,
          sql,
        );
      }

      addColumnIfMissing(
        database,
        'memory_evidence',
        'sensitivity',
        `ALTER TABLE memory_evidence
         ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'
           CHECK (sensitivity IN ('normal', 'sensitive', 'credential'))`,
      );
      addColumnIfMissing(
        database,
        'memory_evidence',
        'source_authority',
        `ALTER TABLE memory_evidence
         ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'legacy_unknown'
           CHECK (source_authority IN (
             'direct_user', 'user_confirmed', 'assistant_inference',
             'imported', 'legacy_unknown'
           ))`,
      );
      addColumnIfMissing(
        database,
        'memory_tombstones',
        'scope_type',
        `ALTER TABLE memory_tombstones
         ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'
           CHECK (scope_type IN ('personal', 'project', 'role', 'session'))`,
      );
      addColumnIfMissing(
        database,
        'memory_tombstones',
        'scope_key',
        `ALTER TABLE memory_tombstones
         ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`,
      );

      database.exec(`
      CREATE TABLE IF NOT EXISTS candidate_resolution_runs (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL
          REFERENCES memory_candidates(id) ON DELETE CASCADE,
        target_memory_item_id TEXT
          REFERENCES memory_items(id) ON DELETE SET NULL,
        relation TEXT NOT NULL
          CHECK (relation IN (
            'equivalent', 'reinforces', 'supersedes',
            'contradicts', 'coexists'
          )),
        method TEXT NOT NULL
          CHECK (method IN ('exact', 'rule', 'embedding', 'model', 'manual')),
        confidence REAL NOT NULL
          CHECK (confidence >= 0 AND confidence <= 1),
        model TEXT,
        prompt_version TEXT,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('completed', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(candidate_id, target_memory_item_id, relation, method)
      );

      CREATE INDEX IF NOT EXISTS candidate_resolution_candidate_idx
        ON candidate_resolution_runs(candidate_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_candidates_scoped_key_idx
        ON memory_candidates(
          user_id, namespace, scope_type, scope_key, normalized_key
        );
      CREATE INDEX IF NOT EXISTS memory_items_scoped_predicate_idx
        ON memory_items(
          user_id, namespace, scope_type, scope_key,
          predicate_key, status
        );
      CREATE INDEX IF NOT EXISTS memories_recall_scope_idx
        ON memories(
          user_id, namespace, scope_type, scope_key,
          sensitivity, status
        );
      CREATE INDEX IF NOT EXISTS memory_tombstones_scoped_idx
        ON memory_tombstones(
          user_id, namespace, scope_type, scope_key, stable_key
        );

      PRAGMA user_version = 16;
      `);
      version = 16;
    }

    if (version < 17) {
      addColumnIfMissing(
        database,
        'extraction_runs',
        'extractor_id',
        `ALTER TABLE extraction_runs
         ADD COLUMN extractor_id TEXT NOT NULL DEFAULT 'memory-extractor'`,
      );
      addColumnIfMissing(
        database,
        'extraction_runs',
        'extractor_version',
        `ALTER TABLE extraction_runs
         ADD COLUMN extractor_version TEXT NOT NULL DEFAULT 'v1'`,
      );
      addColumnIfMissing(
        database,
        'memory_candidates',
        'stable_key',
        `ALTER TABLE memory_candidates
         ADD COLUMN stable_key TEXT NOT NULL DEFAULT ''`,
      );
      database.exec(`
      UPDATE memory_candidates
      SET stable_key =
        scope_type || '::' || scope_key || '::' || normalized_key
      WHERE stable_key = '';

      CREATE INDEX IF NOT EXISTS memory_candidates_stable_key_idx
        ON memory_candidates(
          user_id, namespace, scope_type, scope_key, stable_key
        );

      PRAGMA user_version = 17;
      `);
      version = 17;
    }

    if (version < 18) {
      addColumnIfMissing(
        database,
        'extraction_runs',
        'prompt_contract_version',
        `ALTER TABLE extraction_runs
         ADD COLUMN prompt_contract_version TEXT NOT NULL DEFAULT 'unknown'`,
      );
      database.exec(`
      UPDATE extraction_runs
      SET prompt_contract_version = prompt_version
      WHERE prompt_contract_version = 'unknown';

      PRAGMA user_version = 18;
      `);
      version = 18;
    }

    if (version < 19) {
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
      version = 19;
    }

    if (version < 20) {
      addColumnIfMissing(
        database,
        'memory_tombstones',
        'memory_item_id',
        `ALTER TABLE memory_tombstones
         ADD COLUMN memory_item_id TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_tombstones',
        'deletion_generation',
        `ALTER TABLE memory_tombstones
         ADD COLUMN deletion_generation INTEGER NOT NULL DEFAULT 1`,
      );
      database.exec(`
      -- 注意：SQLite 新版本不允许 UPDATE 目标表在子查询 ORDER BY 中作外层引用
      -- （WHERE 中允许）。这里用 COALESCE 双子查询等价实现原来的优先级排序：
      -- 先取 stable_key 匹配（按 updated_at DESC），否则回退 content_hash 匹配。
      UPDATE memory_tombstones
      SET memory_item_id = COALESCE(
        (
          SELECT i.id
          FROM memory_items i
          WHERE i.user_id = memory_tombstones.user_id
            AND i.namespace = memory_tombstones.namespace
            AND i.scope_type = memory_tombstones.scope_type
            AND i.scope_key = memory_tombstones.scope_key
            AND memory_tombstones.stable_key IS NOT NULL
            AND i.stable_key = memory_tombstones.stable_key
          ORDER BY i.updated_at DESC, i.id ASC
          LIMIT 1
        ),
        (
          SELECT m2.id
          FROM memory_items m2
          JOIN memories m ON m.id = m2.id
          WHERE m2.user_id = memory_tombstones.user_id
            AND m2.namespace = memory_tombstones.namespace
            AND m2.scope_type = memory_tombstones.scope_type
            AND m2.scope_key = memory_tombstones.scope_key
            AND memory_tombstones.content_hash IS NOT NULL
            AND m.checksum = memory_tombstones.content_hash
          ORDER BY m2.updated_at DESC, m2.id ASC
          LIMIT 1
        )
      )
      WHERE memory_item_id IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS
        memory_tombstones_item_generation_idx
        ON memory_tombstones(memory_item_id, deletion_generation)
        WHERE memory_item_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS
        memory_tombstones_active_item_idx
        ON memory_tombstones(
          user_id, memory_item_id, restored_at, deletion_generation DESC
        );

      PRAGMA user_version = 20;
      `);
      version = 20;
    }
    if (version < 21) {
      addColumnIfMissing(
        database,
        'memory_action_requests',
        'review_token',
        `ALTER TABLE memory_action_requests
         ADD COLUMN review_token TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_action_requests',
        'review_claimed_at',
        `ALTER TABLE memory_action_requests
         ADD COLUMN review_claimed_at TEXT`,
      );
      database.exec(`
      CREATE INDEX IF NOT EXISTS memory_action_requests_review_idx
        ON memory_action_requests(
          user_id, status, review_claimed_at, created_at DESC
        );

      PRAGMA user_version = 21;
      `);
      version = 21;
    }
    if (version < 22) {
      let embeddingsHaveGeneration = hasColumn(
        database,
        'memory_embeddings',
        'generation_id',
      );
      let denseRowsHaveGeneration = hasColumn(
        database,
        'memory_dense_lsh',
        'generation_id',
      );
      if (embeddingsHaveGeneration !== denseRowsHaveGeneration) {
        if (
          embeddingsHaveGeneration &&
          Number(
            database
              .prepare(
                'SELECT COUNT(*) AS count FROM memory_embeddings',
              )
              .get()?.count || 0,
          ) === 0
        ) {
          database.exec(`
          DROP TABLE memory_embeddings;
          CREATE TABLE memory_embeddings (
            memory_id TEXT NOT NULL
              REFERENCES memories(id) ON DELETE CASCADE,
            model TEXT NOT NULL,
            text_hash TEXT NOT NULL,
            dimensions INTEGER NOT NULL CHECK (dimensions > 0),
            generation_key TEXT,
            memory_revision INTEGER NOT NULL DEFAULT 1
              CHECK (memory_revision > 0),
            embedding BLOB NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(memory_id, model)
          );
          `);
          embeddingsHaveGeneration = false;
        }
        if (
          denseRowsHaveGeneration &&
          Number(
            database
              .prepare(
                'SELECT COUNT(*) AS count FROM memory_dense_lsh',
              )
              .get()?.count || 0,
          ) === 0
        ) {
          database.exec(`
          DROP TABLE memory_dense_lsh;
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
            memory_revision INTEGER NOT NULL DEFAULT 1
              CHECK (memory_revision > 0),
            PRIMARY KEY(
              memory_id, embedding_model, index_version, band
            )
          );
          `);
          denseRowsHaveGeneration = false;
        }
        if (embeddingsHaveGeneration !== denseRowsHaveGeneration) {
          throw new Error(
            'Dense v22 迁移检测到不完整的 generation_id 表结构',
          );
        }
      }

      database.exec(`
      CREATE TABLE IF NOT EXISTS embedding_model_registry (
        model_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL
          CHECK (length(trim(provider)) > 0),
        model_name TEXT NOT NULL
          CHECK (length(trim(model_name)) > 0),
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
          CHECK (json_valid(metadata_json))
      );

      CREATE INDEX IF NOT EXISTS embedding_model_registry_name_idx
        ON embedding_model_registry(
          provider, model_name, created_at DESC, model_id
        );

      CREATE TABLE IF NOT EXISTS dense_index_generations (
        generation_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL
          REFERENCES embedding_model_registry(model_id)
          ON DELETE RESTRICT,
        embedding_model TEXT NOT NULL
          CHECK (length(trim(embedding_model)) > 0),
        index_version TEXT NOT NULL
          CHECK (length(trim(index_version)) > 0),
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        generation_key TEXT NOT NULL
          CHECK (length(trim(generation_key)) > 0),
        status TEXT NOT NULL
          CHECK (status IN (
            'building', 'ready', 'active', 'retired', 'failed'
          )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ready_at TEXT,
        failure_reason TEXT,
        UNIQUE(model_id, index_version, generation_key)
      );

      CREATE INDEX IF NOT EXISTS dense_index_generations_status_idx
        ON dense_index_generations(
          status, updated_at DESC, generation_id
        );

      CREATE INDEX IF NOT EXISTS dense_index_generations_model_idx
        ON dense_index_generations(
          model_id, index_version, generation_key
        );

      CREATE TABLE IF NOT EXISTS dense_index_aliases (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        active_generation_id TEXT NOT NULL
          REFERENCES dense_index_generations(generation_id)
          ON DELETE RESTRICT,
        building_generation_id TEXT
          REFERENCES dense_index_generations(generation_id)
          ON DELETE RESTRICT,
        previous_generation_id TEXT
          REFERENCES dense_index_generations(generation_id)
          ON DELETE RESTRICT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, namespace),
        CHECK (
          building_generation_id IS NULL
          OR building_generation_id != active_generation_id
        ),
        CHECK (
          previous_generation_id IS NULL
          OR previous_generation_id != active_generation_id
        ),
        CHECK (
          building_generation_id IS NULL
          OR previous_generation_id IS NULL
          OR building_generation_id != previous_generation_id
        )
      );

      CREATE INDEX IF NOT EXISTS dense_index_aliases_generation_idx
        ON dense_index_aliases(
          active_generation_id,
          building_generation_id,
          previous_generation_id
        );
      `);

      addColumnIfMissing(
        database,
        'memory_jobs',
        'required_model_id',
        `ALTER TABLE memory_jobs
         ADD COLUMN required_model_id TEXT
           REFERENCES embedding_model_registry(model_id)
           ON DELETE RESTRICT`,
      );
      addColumnIfMissing(
        database,
        'memory_jobs',
        'required_generation_id',
        `ALTER TABLE memory_jobs
         ADD COLUMN required_generation_id TEXT
           REFERENCES dense_index_generations(generation_id)
           ON DELETE RESTRICT`,
      );

      if (!embeddingsHaveGeneration) {
        database.exec(`
        INSERT OR IGNORE INTO embedding_model_registry (
          model_id, provider, model_name, created_at, metadata_json
        )
        SELECT
          'legacy-model:' || lower(hex(model_name)),
          'legacy',
          model_name,
          MIN(observed_at),
          '{"migratedFromSchema":21}'
        FROM (
          SELECT
            CASE
              WHEN trim(model) = '' THEN 'legacy-unknown'
              ELSE model
            END AS model_name,
            updated_at AS observed_at
          FROM memory_embeddings
          UNION ALL
          SELECT
            CASE
              WHEN trim(embedding_model) = '' THEN 'legacy-unknown'
              ELSE embedding_model
            END AS model_name,
            updated_at AS observed_at
          FROM memory_dense_lsh
          UNION ALL
          SELECT
            CASE
              WHEN trim(embedding_model) = '' THEN 'legacy-unknown'
              ELSE embedding_model
            END AS model_name,
            probed_at AS observed_at
          FROM dense_index_state
        )
        GROUP BY model_name;

        INSERT OR IGNORE INTO dense_index_generations (
          generation_id, model_id, embedding_model, index_version,
          dimensions, generation_key, status, created_at, updated_at,
          ready_at, failure_reason
        )
        SELECT
          'legacy-generation:' ||
            lower(hex(model_name)) || ':' ||
            lower(hex(index_version)) || ':' ||
            lower(hex(generation_key)),
          'legacy-model:' || lower(hex(model_name)),
          model_name,
          index_version,
          MAX(dimensions),
          generation_key,
          'ready',
          MIN(observed_at),
          MAX(observed_at),
          MAX(observed_at),
          NULL
        FROM (
          SELECT
            CASE
              WHEN trim(embedding_model) = ''
                THEN 'legacy-unknown'
              ELSE embedding_model
            END AS model_name,
            index_version,
            CASE
              WHEN dimensions > 0 THEN dimensions
              ELSE 1
            END AS dimensions,
            COALESCE(NULLIF(generation_key, ''), 'legacy-unknown')
              AS generation_key,
            probed_at AS observed_at
          FROM dense_index_state
          UNION ALL
          SELECT
            CASE
              WHEN trim(embedding_model) = ''
                THEN 'legacy-unknown'
              ELSE embedding_model
            END AS model_name,
            index_version,
            CASE
              WHEN dimensions > 0 THEN dimensions
              ELSE 1
            END AS dimensions,
            COALESCE(NULLIF(generation_key, ''), 'legacy-unknown')
              AS generation_key,
            updated_at AS observed_at
          FROM memory_dense_lsh
          UNION ALL
          SELECT
            CASE
              WHEN trim(e.model) = '' THEN 'legacy-unknown'
              ELSE e.model
            END AS model_name,
            COALESCE(
              (
                SELECT s.index_version
                FROM dense_index_state s
                WHERE s.embedding_model = e.model
                  AND COALESCE(
                    NULLIF(s.generation_key, ''),
                    'legacy-unknown'
                  ) = COALESCE(
                    NULLIF(e.generation_key, ''),
                    'legacy-unknown'
                  )
                ORDER BY s.probed_at DESC, s.index_version ASC
                LIMIT 1
              ),
              'dense-sign-lsh-v1'
            ) AS index_version,
            CASE
              WHEN e.dimensions > 0 THEN e.dimensions
              ELSE 1
            END AS dimensions,
            COALESCE(
              NULLIF(e.generation_key, ''),
              'legacy-unknown'
            ) AS generation_key,
            e.updated_at AS observed_at
          FROM memory_embeddings e
        )
        GROUP BY model_name, index_version, generation_key;

        CREATE TABLE memory_embeddings_v22 (
          memory_id TEXT NOT NULL
            REFERENCES memories(id) ON DELETE CASCADE,
          generation_id TEXT NOT NULL
            REFERENCES dense_index_generations(generation_id)
            ON DELETE CASCADE,
          model TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          generation_key TEXT NOT NULL,
          memory_revision INTEGER NOT NULL DEFAULT 1
            CHECK (memory_revision > 0),
          embedding BLOB NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(memory_id, generation_id)
        );

        INSERT INTO memory_embeddings_v22 (
          memory_id, generation_id, model, text_hash, dimensions,
          generation_key, memory_revision, embedding, updated_at
        )
        SELECT
          e.memory_id,
          'legacy-generation:' ||
            lower(hex(
              CASE
                WHEN trim(e.model) = '' THEN 'legacy-unknown'
                ELSE e.model
              END
            )) || ':' ||
            lower(hex(
              COALESCE(
                (
                  SELECT s.index_version
                  FROM dense_index_state s
                  WHERE s.embedding_model = e.model
                    AND COALESCE(
                      NULLIF(s.generation_key, ''),
                      'legacy-unknown'
                    ) = COALESCE(
                      NULLIF(e.generation_key, ''),
                      'legacy-unknown'
                    )
                  ORDER BY s.probed_at DESC, s.index_version ASC
                  LIMIT 1
                ),
                'dense-sign-lsh-v1'
              )
            )) || ':' ||
            lower(hex(
              COALESCE(
                NULLIF(e.generation_key, ''),
                'legacy-unknown'
              )
            )),
          e.model,
          e.text_hash,
          e.dimensions,
          COALESCE(
            NULLIF(e.generation_key, ''),
            'legacy-unknown'
          ),
          e.memory_revision,
          e.embedding,
          e.updated_at
        FROM memory_embeddings e;

        DROP TABLE memory_embeddings;
        ALTER TABLE memory_embeddings_v22 RENAME TO memory_embeddings;

        CREATE INDEX memory_embeddings_model_idx
          ON memory_embeddings(
            model, generation_id, updated_at DESC, memory_id
          );
        CREATE INDEX memory_embeddings_generation_idx
          ON memory_embeddings(
            generation_id, memory_revision, updated_at, memory_id
          );

        CREATE TABLE memory_dense_lsh_v22 (
          memory_id TEXT NOT NULL
            REFERENCES memories(id) ON DELETE CASCADE,
          generation_id TEXT NOT NULL
            REFERENCES dense_index_generations(generation_id)
            ON DELETE CASCADE,
          embedding_model TEXT NOT NULL,
          index_version TEXT NOT NULL,
          band INTEGER NOT NULL CHECK (band >= 0),
          bucket TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          generation_key TEXT NOT NULL,
          memory_revision INTEGER NOT NULL DEFAULT 1
            CHECK (memory_revision > 0),
          PRIMARY KEY(memory_id, generation_id, band)
        );

        INSERT INTO memory_dense_lsh_v22 (
          memory_id, generation_id, embedding_model, index_version,
          band, bucket, text_hash, updated_at, dimensions,
          generation_key, memory_revision
        )
        SELECT
          d.memory_id,
          'legacy-generation:' ||
            lower(hex(
              CASE
                WHEN trim(d.embedding_model) = ''
                  THEN 'legacy-unknown'
                ELSE d.embedding_model
              END
            )) || ':' ||
            lower(hex(d.index_version)) || ':' ||
            lower(hex(
              COALESCE(
                NULLIF(d.generation_key, ''),
                'legacy-unknown'
              )
            )),
          d.embedding_model,
          d.index_version,
          d.band,
          d.bucket,
          d.text_hash,
          d.updated_at,
          CASE
            WHEN d.dimensions > 0 THEN d.dimensions
            ELSE 1
          END,
          COALESCE(
            NULLIF(d.generation_key, ''),
            'legacy-unknown'
          ),
          d.memory_revision
        FROM memory_dense_lsh d;

        DROP TABLE memory_dense_lsh;
        ALTER TABLE memory_dense_lsh_v22 RENAME TO memory_dense_lsh;

        CREATE INDEX memory_dense_lsh_bucket_idx
          ON memory_dense_lsh(
            generation_id, band, bucket, memory_id
          );
        CREATE INDEX memory_dense_lsh_watermark_idx
          ON memory_dense_lsh(
            generation_id, updated_at, memory_id
          );
        CREATE INDEX memory_dense_lsh_generation_idx
          ON memory_dense_lsh(
            embedding_model, index_version, generation_id,
            dimensions, updated_at, memory_id
          );
        CREATE INDEX memory_dense_lsh_generation_key_idx
          ON memory_dense_lsh(
            embedding_model, index_version, generation_key,
            generation_id, dimensions, band, bucket, memory_id
          );
        CREATE INDEX memory_dense_lsh_revision_idx
          ON memory_dense_lsh(
            memory_id, generation_id, memory_revision, band
          );

        WITH indexed_generations AS (
          SELECT
            memory_id, generation_id, MAX(updated_at) AS updated_at
          FROM memory_dense_lsh
          GROUP BY memory_id, generation_id
          UNION
          SELECT
            memory_id, generation_id, updated_at
          FROM memory_embeddings
        ),
        scoped_generations AS (
          SELECT
            m.user_id,
            m.namespace,
            i.generation_id,
            COUNT(DISTINCT i.memory_id) AS covered,
            MAX(i.updated_at) AS indexed_at
          FROM indexed_generations i
          JOIN memories m ON m.id = i.memory_id
          GROUP BY m.user_id, m.namespace, i.generation_id
        ),
        ranked_generations AS (
          SELECT
            user_id,
            namespace,
            generation_id,
            indexed_at,
            ROW_NUMBER() OVER (
              PARTITION BY user_id, namespace
              ORDER BY
                covered DESC,
                indexed_at DESC,
                generation_id ASC
            ) AS rank
          FROM scoped_generations
        )
        INSERT OR IGNORE INTO dense_index_aliases (
          user_id, namespace, active_generation_id,
          building_generation_id, previous_generation_id,
          revision, updated_at
        )
        SELECT
          user_id,
          namespace,
          generation_id,
          NULL,
          NULL,
          1,
          indexed_at
        FROM ranked_generations
        WHERE rank = 1;

        UPDATE dense_index_generations
        SET status = 'active',
            updated_at = COALESCE(ready_at, updated_at)
        WHERE generation_id IN (
          SELECT active_generation_id
          FROM dense_index_aliases
        );
        `);
      } else {
        database.exec(`
        CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx
          ON memory_embeddings(
            model, generation_id, updated_at DESC, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_embeddings_generation_idx
          ON memory_embeddings(
            generation_id, memory_revision, updated_at, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_bucket_idx
          ON memory_dense_lsh(
            generation_id, band, bucket, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_watermark_idx
          ON memory_dense_lsh(
            generation_id, updated_at, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_generation_idx
          ON memory_dense_lsh(
            embedding_model, index_version, generation_id,
            dimensions, updated_at, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_generation_key_idx
          ON memory_dense_lsh(
            embedding_model, index_version, generation_key,
            generation_id, dimensions, band, bucket, memory_id
          );
        CREATE INDEX IF NOT EXISTS memory_dense_lsh_revision_idx
          ON memory_dense_lsh(
            memory_id, generation_id, memory_revision, band
          );
        `);
      }

      database.exec(`
      CREATE INDEX IF NOT EXISTS memory_jobs_affinity_idx
        ON memory_jobs(
          status, job_type, required_model_id,
          required_generation_id, priority DESC, available_at ASC
        );

      PRAGMA user_version = 22;
      `);
      version = 22;
    }
    if (version < 23) {
      database.exec(`
      DROP INDEX IF EXISTS memory_dense_lsh_watermark_idx;
      DROP INDEX IF EXISTS memory_dense_lsh_generation_idx;
      DROP INDEX IF EXISTS memory_dense_lsh_generation_key_idx;
      DROP INDEX IF EXISTS memory_dense_lsh_revision_idx;
      PRAGMA user_version = 23;
      `);
      version = 23;
    }
    if (version < 24) {
      addColumnIfMissing(
        database,
        'memory_tombstones',
        'kind',
        `ALTER TABLE memory_tombstones
         ADD COLUMN kind TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_tombstones',
        'normalized_key',
        `ALTER TABLE memory_tombstones
         ADD COLUMN normalized_key TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_tombstones',
        'normalized_value',
        `ALTER TABLE memory_tombstones
         ADD COLUMN normalized_value TEXT`,
      );
      addColumnIfMissing(
        database,
        'memory_tombstones',
        'semantic_fingerprint',
        `ALTER TABLE memory_tombstones
         ADD COLUMN semantic_fingerprint TEXT`,
      );
      database.exec(`
      UPDATE memory_tombstones
      SET
        kind = COALESCE(
          kind,
          (
            SELECT i.kind
            FROM memory_items i
            WHERE i.id = memory_tombstones.memory_item_id
          )
        ),
        normalized_key = COALESCE(
          normalized_key,
          (
            SELECT i.predicate_key
            FROM memory_items i
            WHERE i.id = memory_tombstones.memory_item_id
          )
        ),
        normalized_value = COALESCE(
          normalized_value,
          (
            SELECT i.normalized_value
            FROM memory_items i
            WHERE i.id = memory_tombstones.memory_item_id
          )
        )
      WHERE memory_item_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS memory_tombstones_normalized_key_idx
        ON memory_tombstones(
          user_id,
          namespace,
          scope_type,
          scope_key,
          normalized_key,
          restored_at
        );

      CREATE TABLE IF NOT EXISTS namespace_quality_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        extraction_precision REAL NOT NULL
          CHECK (extraction_precision >= 0 AND extraction_precision <= 1),
        candidate_recall REAL NOT NULL
          CHECK (candidate_recall >= 0 AND candidate_recall <= 1),
        credential_saves INTEGER NOT NULL
          CHECK (credential_saves >= 0),
        conflict_accuracy REAL NOT NULL
          CHECK (conflict_accuracy >= 0 AND conflict_accuracy <= 1),
        semantic_duplicate_rate REAL NOT NULL
          CHECK (
            semantic_duplicate_rate >= 0
            AND semantic_duplicate_rate <= 1
          ),
        extraction_precision_samples INTEGER NOT NULL
          CHECK (extraction_precision_samples >= 0),
        candidate_recall_samples INTEGER NOT NULL
          CHECK (candidate_recall_samples >= 0),
        credential_samples INTEGER NOT NULL
          CHECK (credential_samples >= 0),
        conflict_samples INTEGER NOT NULL
          CHECK (conflict_samples >= 0),
        semantic_duplicate_samples INTEGER NOT NULL
          CHECK (semantic_duplicate_samples >= 0),
        passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
        thresholds_json TEXT NOT NULL,
        threshold_results_json TEXT NOT NULL,
        failed_metrics_json TEXT NOT NULL,
        model_versions_json TEXT NOT NULL,
        prompt_versions_json TEXT NOT NULL,
        evaluator_version TEXT NOT NULL,
        dataset_id TEXT NOT NULL,
        dataset_sha256 TEXT,
        evaluated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS namespace_quality_snapshots_scope_idx
        ON namespace_quality_snapshots(
          user_id,
          namespace,
          evaluated_at DESC,
          created_at DESC
        );

      CREATE TABLE IF NOT EXISTS namespace_rollout_state (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        rollout_mode TEXT NOT NULL
          CHECK (rollout_mode IN ('shadow', 'auto')),
        quality_state TEXT NOT NULL
          CHECK (
            quality_state IN (
              'unassessed', 'bootstrap', 'passed', 'failed'
            )
          ),
        active_snapshot_id TEXT
          REFERENCES namespace_quality_snapshots(id)
          ON DELETE SET NULL,
        override_kind TEXT
          CHECK (
            override_kind IS NULL
            OR override_kind = 'bootstrap_auto'
          ),
        override_reason TEXT,
        override_actor TEXT,
        override_created_at TEXT,
        override_expires_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, namespace)
      );

      CREATE INDEX IF NOT EXISTS namespace_rollout_mode_idx
        ON namespace_rollout_state(
          rollout_mode,
          quality_state,
          updated_at DESC
        );

      CREATE TABLE IF NOT EXISTS namespace_recall_shadow_comparisons (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        new_result_ids_json TEXT NOT NULL,
        legacy_result_ids_json TEXT NOT NULL,
        new_only_ids_json TEXT NOT NULL,
        legacy_only_ids_json TEXT NOT NULL,
        injected_result_ids_json TEXT NOT NULL,
        injection_path TEXT NOT NULL
          CHECK (
            injection_path IN ('hybrid', 'legacy_fts', 'none')
          ),
        effective_mode TEXT NOT NULL
          CHECK (effective_mode IN ('off', 'shadow', 'auto')),
        decision_reason TEXT NOT NULL,
        quality_state TEXT NOT NULL
          CHECK (
            quality_state IN (
              'unassessed', 'bootstrap', 'passed', 'failed'
            )
          ),
        snapshot_id TEXT
          REFERENCES namespace_quality_snapshots(id)
          ON DELETE SET NULL,
        new_recall_quality TEXT NOT NULL
          CHECK (
            new_recall_quality IN (
              'full', 'degraded', 'unavailable'
            )
          ),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS namespace_recall_shadow_scope_idx
        ON namespace_recall_shadow_comparisons(
          user_id,
          namespace,
          created_at DESC
        );

      PRAGMA user_version = 24;
      `);
      const activeTombstoneIds = (
        database
          .prepare(
            `SELECT id
             FROM memory_tombstones
             WHERE restored_at IS NULL
             ORDER BY id ASC`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((row) => String(row.id ?? '').trim())
        .filter(Boolean);
      backfillTombstoneSemanticFingerprints(database, {
        tombstoneIds: activeTombstoneIds,
        requireComplete: true,
      });
      version = 24;
    }
    if (version < 25) {
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
      version = 25;
    }
    if (version < 26) {
      assertNoLegacyProjectScopes(database);
      addColumnIfMissing(
        database,
        'conversation_sessions',
        'project_id',
        `ALTER TABLE conversation_sessions
         ADD COLUMN project_id TEXT`,
      );
      database.exec(`
      CREATE INDEX IF NOT EXISTS conversation_sessions_project_idx
        ON conversation_sessions(
          user_id,
          namespace,
          project_id,
          started_at DESC
        )
        WHERE project_id IS NOT NULL;

      PRAGMA user_version = 26;
      `);
      installIdentityImmutabilityTriggers(database);
      if (!hasSchemaMigrationLedger(database)) {
        createSchemaMigrationLedger(database);
        recordV26CurrentSchemaAttestation(
          database,
          fromVersion,
          'migration',
        );
      } else {
        const attestation = assertSchemaMigrationLedger(database, true);
        if (attestation.generation === 'v1') {
          replaceV26SchemaAttestation(database, attestation);
        }
      }
      version = 26;
    }
    if (version === IDENTITY_SCHEMA_VERSION) {
      ensureV26SchemaAttestation(database);
    }
    if (version < 27) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS retrieval_traces (
        trace_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_summary_json TEXT NOT NULL DEFAULT '[]',
        log_mode TEXT NOT NULL
          CHECK (log_mode IN ('metadata', 'diagnostic')),
        query_hash TEXT NOT NULL,
        query_text TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        quality_state TEXT
          CHECK (
            quality_state IS NULL OR
            quality_state IN ('full', 'degraded', 'unavailable')
          ),
        result_count INTEGER NOT NULL DEFAULT 0
          CHECK (result_count >= 0),
        total_duration_ms REAL,
        error_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS retrieval_traces_user_created_idx
        ON retrieval_traces(user_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS retrieval_traces_scope_created_idx
        ON retrieval_traces(user_id, namespace, started_at DESC);
      CREATE INDEX IF NOT EXISTS retrieval_traces_quality_idx
        ON retrieval_traces(user_id, quality_state, started_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_trace_events (
        trace_id TEXT NOT NULL
          REFERENCES retrieval_traces(trace_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        stage TEXT NOT NULL
          CHECK (stage IN (
            'request', 'rewrite', 'channels', 'fusion', 'semantic',
            'rerank', 'selection', 'context', 'result'
          )),
        event_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY (trace_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS retrieval_trace_events_stage_idx
        ON retrieval_trace_events(stage, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_feedback_examples (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        trace_id TEXT
          REFERENCES retrieval_traces(trace_id) ON DELETE SET NULL,
        memory_id TEXT
          REFERENCES memory_items(id) ON DELETE SET NULL,
        feedback TEXT NOT NULL
          CHECK (feedback IN ('used', 'confirmed', 'rejected')),
        query_hash TEXT NOT NULL,
        query_text TEXT,
        candidate_rank INTEGER,
        candidate_score REAL,
        features_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS retrieval_feedback_user_created_idx
        ON retrieval_feedback_examples(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS retrieval_feedback_trace_idx
        ON retrieval_feedback_examples(user_id, trace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS retrieval_feedback_memory_idx
        ON retrieval_feedback_examples(user_id, memory_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS retrieval_log_state (
        user_id TEXT PRIMARY KEY,
        last_success_at TEXT,
        last_failure_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
          CHECK (consecutive_failures >= 0),
        total_failures INTEGER NOT NULL DEFAULT 0
          CHECK (total_failures >= 0),
        last_error TEXT,
        jsonl_path TEXT
      );

      PRAGMA user_version = 27;
      `);
      version = 27;
    }
    if (version < 28) {
      database.exec(`
      ALTER TABLE client_persona_bindings
        RENAME TO client_persona_bindings_v27;

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
        UNIQUE(
          principal_id,
          client_type,
          client_instance_id,
          persona_id
        )
      );

      INSERT INTO client_persona_bindings (
        id, principal_id, client_type, client_instance_id,
        persona_id, display_name, status, created_at,
        updated_at, last_seen_at
      )
      SELECT
        id, principal_id, client_type, client_instance_id,
        persona_id, display_name, status, created_at,
        updated_at, last_seen_at
      FROM client_persona_bindings_v27;

      DROP TABLE client_persona_bindings_v27;

      CREATE INDEX client_persona_principal_idx
        ON client_persona_bindings(
          principal_id,
          client_type,
          status,
          updated_at DESC
        );

      PRAGMA user_version = 28;
      `);
      version = 28;
    }
    if (version < 29) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS memory_reflection_settings (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'shadow'
          CHECK (mode IN ('off', 'shadow')),
        daily_call_limit INTEGER NOT NULL DEFAULT 48
          CHECK (daily_call_limit >= 0 AND daily_call_limit <= 1000),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, namespace)
      );

      CREATE TABLE IF NOT EXISTS memory_reflection_checkpoints (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        last_turn_occurred_at TEXT,
        last_turn_id TEXT,
        extractor_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        extraction_prompt_version TEXT NOT NULL,
        reflection_model TEXT NOT NULL,
        reflection_prompt_version TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        last_success_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, namespace, scope_type, scope_key)
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_checkpoints_lag_idx
        ON memory_reflection_checkpoints(
          user_id, namespace, last_turn_occurred_at ASC, last_turn_id ASC
        );

      CREATE TABLE IF NOT EXISTS memory_reflection_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        run_type TEXT NOT NULL
          CHECK (run_type IN ('reextract', 'reflect')),
        trigger TEXT NOT NULL
          CHECK (trigger IN (
            'sweep', 'model_upgrade', 'manual', 'repair', 'pre_retention'
          )),
        status TEXT NOT NULL
          CHECK (status IN (
            'pending', 'running', 'completed', 'partial', 'failed',
            'dead', 'cancelled'
          )),
        window_start TEXT,
        window_end TEXT,
        turn_set_hash TEXT NOT NULL,
        input_turn_count INTEGER NOT NULL DEFAULT 0
          CHECK (input_turn_count >= 0),
        candidate_count INTEGER NOT NULL DEFAULT 0
          CHECK (candidate_count >= 0),
        accepted_count INTEGER NOT NULL DEFAULT 0
          CHECK (accepted_count >= 0),
        pending_count INTEGER NOT NULL DEFAULT 0
          CHECK (pending_count >= 0),
        rejected_count INTEGER NOT NULL DEFAULT 0
          CHECK (rejected_count >= 0),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        extractor_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        lease_owner TEXT,
        lease_until TEXT,
        last_error TEXT,
        requested_by TEXT NOT NULL,
        cancel_requested_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (
          user_id, namespace, scope_type, scope_key, run_type,
          turn_set_hash, implementation_version
        )
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_runs_queue_idx
        ON memory_reflection_runs(status, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_reflection_runs_owner_idx
        ON memory_reflection_runs(
          user_id, namespace, scope_type, scope_key, created_at DESC
        );

      CREATE TABLE IF NOT EXISTS memory_candidate_evidence (
        candidate_id TEXT NOT NULL
          REFERENCES memory_candidates(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        excerpt TEXT,
        excerpt_hash TEXT NOT NULL,
        evidence_type TEXT NOT NULL
          CHECK (evidence_type IN ('direct', 'pattern_support')),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (candidate_id, turn_id, excerpt_hash)
      );

      CREATE INDEX IF NOT EXISTS memory_candidate_evidence_turn_idx
        ON memory_candidate_evidence(turn_id, candidate_id);
      `);
      addColumnIfMissing(
        database,
        'memory_candidates',
        'reflection_run_id',
        `ALTER TABLE memory_candidates
         ADD COLUMN reflection_run_id TEXT
           REFERENCES memory_reflection_runs(id) ON DELETE SET NULL`,
      );
      addColumnIfMissing(
        database,
        'memory_candidates',
        'candidate_origin',
        `ALTER TABLE memory_candidates
         ADD COLUMN candidate_origin TEXT NOT NULL DEFAULT 'turn_extraction'
           CHECK (candidate_origin IN (
             'turn_extraction', 'history_reextract', 'reflection'
           ))`,
      );
      addColumnIfMissing(
        database,
        'memory_candidates',
        'claim_fingerprint',
        `ALTER TABLE memory_candidates ADD COLUMN claim_fingerprint TEXT`,
      );
      database.exec(`
      CREATE INDEX IF NOT EXISTS memory_candidates_reflection_run_idx
        ON memory_candidates(reflection_run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS memory_candidates_claim_fingerprint_idx
        ON memory_candidates(
          user_id, namespace, scope_type, scope_key,
          claim_fingerprint, state, created_at DESC
        )
        WHERE claim_fingerprint IS NOT NULL;

      CREATE INDEX IF NOT EXISTS conversation_turns_reflection_window_idx
        ON conversation_turns(
          user_id, namespace, occurred_at ASC, id ASC
        )
        WHERE role = 'user';

      PRAGMA user_version = 29;
      `);
      version = 29;
    }
    if (version < 30) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS memory_turn_ingest_order (
        ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO memory_turn_ingest_order (
        turn_id, user_id, namespace, ingested_at
      )
      SELECT id, user_id, namespace, created_at
      FROM conversation_turns
      ORDER BY created_at ASC, rowid ASC;

      CREATE INDEX IF NOT EXISTS memory_turn_ingest_owner_idx
        ON memory_turn_ingest_order(
          user_id, namespace, ingest_seq ASC
        );

      CREATE TRIGGER IF NOT EXISTS conversation_turn_ingest_order_insert
      AFTER INSERT ON conversation_turns
      BEGIN
        INSERT OR IGNORE INTO memory_turn_ingest_order (
          turn_id, user_id, namespace, ingested_at
        ) VALUES (NEW.id, NEW.user_id, NEW.namespace, NEW.created_at);
      END;
      `);
      if (!hasColumn(
        database,
        'memory_reflection_checkpoints',
        'run_type',
      )) {
        database.exec(`
      DROP INDEX IF EXISTS memory_reflection_checkpoints_lag_idx;
      ALTER TABLE memory_reflection_checkpoints
        RENAME TO memory_reflection_checkpoints_v29;

      CREATE TABLE memory_reflection_checkpoints (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        run_type TEXT NOT NULL
          CHECK (run_type IN ('reextract', 'reflect')),
        generation_key TEXT NOT NULL,
        last_ingest_seq INTEGER NOT NULL DEFAULT 0
          CHECK (last_ingest_seq >= 0),
        last_turn_occurred_at TEXT,
        last_turn_id TEXT,
        extractor_id TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        extraction_prompt_version TEXT NOT NULL,
        reflection_model TEXT NOT NULL,
        reflection_prompt_version TEXT NOT NULL,
        implementation_version TEXT NOT NULL,
        last_success_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (
          user_id, namespace, scope_type, scope_key,
          run_type, generation_key
        )
      );

      INSERT INTO memory_reflection_checkpoints (
        id, user_id, namespace, scope_type, scope_key,
        run_type, generation_key, last_ingest_seq,
        last_turn_occurred_at, last_turn_id,
        extractor_id, extractor_version, extraction_prompt_version,
        reflection_model, reflection_prompt_version,
        implementation_version, last_success_at, created_at, updated_at
      )
      SELECT
        id || ':reextract', user_id, namespace, scope_type, scope_key,
        'reextract',
        implementation_version || ':' || extractor_id || ':' ||
          extractor_version || ':' || extraction_prompt_version,
        COALESCE((
          SELECT ingest_seq FROM memory_turn_ingest_order o
          WHERE o.turn_id = memory_reflection_checkpoints_v29.last_turn_id
        ), 0),
        last_turn_occurred_at, last_turn_id,
        extractor_id, extractor_version, extraction_prompt_version,
        reflection_model, reflection_prompt_version,
        implementation_version, last_success_at, created_at, updated_at
      FROM memory_reflection_checkpoints_v29;

      INSERT INTO memory_reflection_checkpoints (
        id, user_id, namespace, scope_type, scope_key,
        run_type, generation_key, last_ingest_seq,
        last_turn_occurred_at, last_turn_id,
        extractor_id, extractor_version, extraction_prompt_version,
        reflection_model, reflection_prompt_version,
        implementation_version, last_success_at, created_at, updated_at
      )
      SELECT
        id || ':reflect', user_id, namespace, scope_type, scope_key,
        'reflect',
        implementation_version || ':' || reflection_model || ':' ||
          reflection_prompt_version,
        COALESCE((
          SELECT ingest_seq FROM memory_turn_ingest_order o
          WHERE o.turn_id = memory_reflection_checkpoints_v29.last_turn_id
        ), 0),
        last_turn_occurred_at, last_turn_id,
        extractor_id, extractor_version, extraction_prompt_version,
        reflection_model, reflection_prompt_version,
        implementation_version, last_success_at, created_at, updated_at
      FROM memory_reflection_checkpoints_v29;

      DROP TABLE memory_reflection_checkpoints_v29;

      CREATE INDEX IF NOT EXISTS memory_reflection_checkpoints_lag_idx
        ON memory_reflection_checkpoints(
          user_id, namespace, run_type, generation_key,
          last_ingest_seq ASC
        );
        `);
      }
      database.exec(`

      CREATE TABLE IF NOT EXISTS memory_reflection_run_turns (
        run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE RESTRICT,
        ingest_seq INTEGER NOT NULL CHECK (ingest_seq > 0),
        turn_alias TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        content_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (run_id, turn_id),
        UNIQUE (run_id, ordinal),
        UNIQUE (run_id, turn_alias)
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_run_turns_turn_idx
        ON memory_reflection_run_turns(turn_id, run_id);

      CREATE TABLE IF NOT EXISTS memory_reflection_model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        budget_day TEXT NOT NULL,
        call_type TEXT NOT NULL
          CHECK (call_type IN ('reextract', 'reflect')),
        model TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL DEFAULT 0
          CHECK (estimated_tokens >= 0),
        status TEXT NOT NULL
          CHECK (status IN (
            'reserved', 'completed', 'failed', 'refunded'
          )),
        error TEXT,
        reserved_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (run_id, call_type, id)
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_model_calls_budget_idx
        ON memory_reflection_model_calls(
          user_id, namespace, budget_day, status
        );

      CREATE TABLE IF NOT EXISTS memory_reflection_claims (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        claim_fingerprint TEXT NOT NULL,
        candidate_id TEXT
          REFERENCES memory_candidates(id) ON DELETE SET NULL,
        decision TEXT NOT NULL DEFAULT 'active'
          CHECK (decision IN (
            'active', 'confirmed', 'rejected', 'blocked'
          )),
        first_run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE RESTRICT,
        last_run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (
          user_id, namespace, scope_type, scope_key, claim_fingerprint
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS memory_reflection_claims_candidate_idx
        ON memory_reflection_claims(candidate_id)
        WHERE candidate_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS memory_reflection_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL
          REFERENCES memory_reflection_runs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS memory_reflection_events_run_idx
        ON memory_reflection_events(run_id, id ASC);
      `);
      addColumnIfMissing(
        database,
        'memory_reflection_runs',
        'generation_key',
        `ALTER TABLE memory_reflection_runs
         ADD COLUMN generation_key TEXT NOT NULL DEFAULT 'legacy-v29'`,
      );
      addColumnIfMissing(
        database,
        'memory_reflection_runs',
        'window_start_ingest_seq',
        `ALTER TABLE memory_reflection_runs
         ADD COLUMN window_start_ingest_seq INTEGER`,
      );
      addColumnIfMissing(
        database,
        'memory_reflection_runs',
        'window_end_ingest_seq',
        `ALTER TABLE memory_reflection_runs
         ADD COLUMN window_end_ingest_seq INTEGER`,
      );
      addColumnIfMissing(
        database,
        'memory_candidate_evidence',
        'user_id',
        `ALTER TABLE memory_candidate_evidence
         ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
      );
      addColumnIfMissing(
        database,
        'memory_candidate_evidence',
        'namespace',
        `ALTER TABLE memory_candidate_evidence
         ADD COLUMN namespace TEXT NOT NULL DEFAULT ''`,
      );
      addColumnIfMissing(
        database,
        'memory_candidate_evidence',
        'scope_type',
        `ALTER TABLE memory_candidate_evidence
         ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'personal'`,
      );
      addColumnIfMissing(
        database,
        'memory_candidate_evidence',
        'scope_key',
        `ALTER TABLE memory_candidate_evidence
         ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'self'`,
      );
      database.exec(`
      UPDATE memory_candidate_evidence
      SET
        user_id = (
          SELECT c.user_id FROM memory_candidates c
          WHERE c.id = memory_candidate_evidence.candidate_id
        ),
        namespace = (
          SELECT c.namespace FROM memory_candidates c
          WHERE c.id = memory_candidate_evidence.candidate_id
        ),
        scope_type = (
          SELECT c.scope_type FROM memory_candidates c
          WHERE c.id = memory_candidate_evidence.candidate_id
        ),
        scope_key = (
          SELECT c.scope_key FROM memory_candidates c
          WHERE c.id = memory_candidate_evidence.candidate_id
        );

      CREATE TRIGGER IF NOT EXISTS memory_candidate_evidence_owner_insert
      BEFORE INSERT ON memory_candidate_evidence
      WHEN NOT EXISTS (
        SELECT 1
        FROM memory_candidates c
        JOIN conversation_turns t ON t.id = NEW.turn_id
        WHERE c.id = NEW.candidate_id
          AND c.user_id = NEW.user_id
          AND c.namespace = NEW.namespace
          AND c.scope_type = NEW.scope_type
          AND c.scope_key = NEW.scope_key
          AND t.user_id = c.user_id
          AND t.namespace = c.namespace
      )
      BEGIN
        SELECT RAISE(ABORT, 'candidate evidence owner/scope mismatch');
      END;

      CREATE TRIGGER IF NOT EXISTS memory_candidate_evidence_owner_update
      BEFORE UPDATE OF
        candidate_id, turn_id, user_id, namespace, scope_type, scope_key
      ON memory_candidate_evidence
      BEGIN
        SELECT RAISE(ABORT, 'candidate evidence identity is immutable');
      END;

      PRAGMA user_version = 30;
      `);
      version = 30;
    }
    if (version < 31) {
      database.exec(`
      DROP TRIGGER IF EXISTS conversation_turn_ingest_order_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_owner_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_identity_immutable;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_update;
      DROP INDEX IF EXISTS memory_turn_ingest_owner_idx;

      ALTER TABLE memory_turn_ingest_order
        RENAME TO memory_turn_ingest_order_v30;

      CREATE TABLE memory_turn_ingest_order (
        ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );

      INSERT INTO memory_turn_ingest_order (
        ingest_seq, turn_id, session_id, user_id, namespace, ingested_at
      )
      SELECT
        o.ingest_seq, o.turn_id, t.session_id,
        o.user_id, o.namespace, o.ingested_at
      FROM memory_turn_ingest_order_v30 o
      JOIN conversation_turns t
        ON t.id = o.turn_id
       AND t.user_id = o.user_id
       AND t.namespace = o.namespace
      JOIN conversation_sessions s
        ON s.id = t.session_id
       AND s.user_id = o.user_id
       AND s.namespace = o.namespace
      ORDER BY o.ingest_seq ASC;
      `);
      const legacyIngestCount = Number(
        database.prepare(
          'SELECT COUNT(*) AS count FROM memory_turn_ingest_order_v30',
        ).get()?.count || 0,
      );
      const migratedIngestCount = Number(
        database.prepare(
          'SELECT COUNT(*) AS count FROM memory_turn_ingest_order',
        ).get()?.count || 0,
      );
      if (legacyIngestCount !== migratedIngestCount) {
        throw new Error(
          'schema v31 ingest ledger 包含无法证明的 owner/session 绑定',
        );
      }
      database.exec(`
      DROP TABLE memory_turn_ingest_order_v30;

      CREATE INDEX memory_turn_ingest_owner_idx
        ON memory_turn_ingest_order(
          user_id, namespace, ingest_seq ASC
        );
      CREATE INDEX memory_turn_ingest_session_idx
        ON memory_turn_ingest_order(
          user_id, namespace, session_id, ingest_seq ASC
        );
      `);
      for (const trigger of V31_REFLECTION_TRIGGERS) {
        database.exec(trigger.sql);
      }
      database.exec('PRAGMA user_version = 31;');
      version = 31;
    }
    if (version < 32) {
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
      version = 32;
    }
    if (version < 33) {
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
      version = 33;
    }
    if (version < 34) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_changes (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL
          REFERENCES account_principals(id) ON DELETE RESTRICT,
        namespace TEXT NOT NULL,
        event_type TEXT NOT NULL
          CHECK (
            event_type IN (
              'conversation.upsert', 'conversation.delete',
              'message.upsert', 'message.delete',
              'message.active_variant'
            )
          ),
        conversation_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL,
        resource_version INTEGER NOT NULL CHECK (resource_version > 0),
        occurred_at TEXT NOT NULL,
        tombstone INTEGER NOT NULL DEFAULT 0
          CHECK (tombstone IN (0, 1)),
        resource_json TEXT
          CHECK (
            resource_json IS NULL
            OR (
              json_valid(resource_json)
              AND json_type(resource_json) = 'object'
            )
          ),
        expires_at TEXT NOT NULL,
        CHECK (
          (tombstone = 1 AND resource_json IS NULL)
          OR (tombstone = 0 AND resource_json IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS conversation_changes_owner_sequence_idx
        ON conversation_changes(user_id, namespace, sequence);
      CREATE INDEX IF NOT EXISTS conversation_changes_expiry_idx
        ON conversation_changes(expires_at, user_id, namespace);
      `);
      database.exec('PRAGMA user_version = 34;');
      version = 34;
    }
    if (version < 35) {
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
      version = 35;
    }
    if (version < 36) {
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
      version = 36;
    }
    if (version < 37) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_episodes (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL UNIQUE
          REFERENCES memories(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        user_turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        assistant_turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'archived', 'deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, namespace, user_turn_id, assistant_turn_id)
      );

      CREATE INDEX IF NOT EXISTS conversation_episodes_owner_time_idx
        ON conversation_episodes(
          user_id, namespace, scope_type, scope_key,
          status, occurred_at DESC
        );
      CREATE INDEX IF NOT EXISTS conversation_episodes_session_idx
        ON conversation_episodes(session_id, occurred_at ASC);

      CREATE TABLE IF NOT EXISTS conversation_episode_turns (
        episode_id TEXT NOT NULL
          REFERENCES conversation_episodes(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
        content_hash TEXT NOT NULL,
        PRIMARY KEY(episode_id, turn_id),
        UNIQUE(episode_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS conversation_episode_turns_turn_idx
        ON conversation_episode_turns(turn_id, episode_id);

      CREATE TABLE IF NOT EXISTS memory_pattern_observations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        claim_fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        value_text TEXT NOT NULL,
        negated INTEGER NOT NULL DEFAULT 0 CHECK (negated IN (0, 1)),
        turn_id TEXT NOT NULL
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        excerpt TEXT NOT NULL,
        excerpt_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observation_state TEXT NOT NULL DEFAULT 'supporting'
          CHECK (observation_state IN (
            'supporting', 'contradicting', 'superseded', 'blocked'
          )),
        first_run_id TEXT
          REFERENCES memory_reflection_runs(id) ON DELETE SET NULL,
        last_run_id TEXT
          REFERENCES memory_reflection_runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(
          user_id, namespace, scope_type, scope_key,
          claim_fingerprint, turn_id
        )
      );

      CREATE INDEX IF NOT EXISTS memory_pattern_observations_claim_idx
        ON memory_pattern_observations(
          user_id, namespace, scope_type, scope_key,
          claim_fingerprint, observation_state, occurred_at ASC
        );
      CREATE INDEX IF NOT EXISTS memory_pattern_observations_turn_idx
        ON memory_pattern_observations(turn_id, claim_fingerprint);

      CREATE TABLE IF NOT EXISTS conversation_memory_summaries (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL UNIQUE
          REFERENCES memories(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        summary_type TEXT NOT NULL
          CHECK (summary_type IN ('session', 'day', 'week')),
        bucket_key TEXT NOT NULL,
        scope_type TEXT NOT NULL
          CHECK (scope_type IN ('personal', 'project', 'role', 'session')),
        scope_key TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        source_count INTEGER NOT NULL CHECK (source_count > 0),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'superseded', 'quarantined', 'deleted')),
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(
          user_id, namespace, summary_type, bucket_key,
          scope_type, scope_key, source_fingerprint
        )
      );

      CREATE INDEX IF NOT EXISTS conversation_memory_summaries_scope_idx
        ON conversation_memory_summaries(
          user_id, namespace, summary_type, scope_type,
          scope_key, bucket_key DESC, status
        );

      CREATE TABLE IF NOT EXISTS conversation_memory_summary_sources (
        summary_id TEXT NOT NULL
          REFERENCES conversation_memory_summaries(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL
          REFERENCES conversation_episodes(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY(summary_id, episode_id),
        UNIQUE(summary_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS conversation_memory_summary_sources_source_idx
        ON conversation_memory_summary_sources(episode_id, summary_id);

      CREATE INDEX IF NOT EXISTS memory_evidence_turn_version_idx
        ON memory_evidence(turn_id, memory_version_id);

      `);
      database.exec('DROP TRIGGER IF EXISTS memory_event_consolidation_job;');
      database.exec(V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER);
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
      database.exec('PRAGMA user_version = 37;');
      version = 37;
    }
    if (version < 38) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_episode_compactions (
        episode_id TEXT PRIMARY KEY
          REFERENCES conversation_episodes(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL UNIQUE
          REFERENCES memories(id) ON DELETE CASCADE,
        summary_id TEXT
          REFERENCES conversation_memory_summaries(id) ON DELETE SET NULL,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        compacted_at TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        removed_embedding_rows INTEGER NOT NULL DEFAULT 0,
        removed_dense_rows INTEGER NOT NULL DEFAULT 0,
        removed_ann_rows INTEGER NOT NULL DEFAULT 0,
        removed_term_rows INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS conversation_episode_compactions_owner_idx
        ON conversation_episode_compactions(
          user_id, namespace, compacted_at ASC, episode_id
        );

      UPDATE memory_jobs
      SET status = 'completed',
          lease_until = NULL,
          lease_owner = NULL,
          last_error = 'reflection_run_already_terminal',
          updated_at = COALESCE(
            (
              SELECT completed_at
              FROM memory_reflection_runs run
              WHERE run.id = json_extract(
                memory_jobs.payload_json,
                '$.runId'
              )
            ),
            updated_at
          )
      WHERE job_type IN (
          'reflect_turn_window',
          'reextract_turn_window'
        )
        AND status IN ('pending', 'failed')
        AND EXISTS (
          SELECT 1
          FROM memory_reflection_runs run
          WHERE run.id = json_extract(
              memory_jobs.payload_json,
              '$.runId'
            )
            AND run.status IN ('completed', 'partial', 'cancelled')
        );

      UPDATE memory_jobs AS older
      SET status = 'completed',
          lease_until = NULL,
          lease_owner = NULL,
          last_error = 'coalesced_during_schema38_migration',
          updated_at = COALESCE(
            (
              SELECT newer.updated_at
              FROM memory_jobs newer
              WHERE newer.job_type = 'consolidate_memory_change'
                AND newer.user_id = older.user_id
                AND newer.namespace = older.namespace
                AND json_extract(newer.payload_json, '$.memoryId') =
                  json_extract(older.payload_json, '$.memoryId')
                AND newer.status IN ('pending', 'failed', 'running')
                AND (
                  newer.created_at > older.created_at
                  OR (
                    newer.created_at = older.created_at
                    AND newer.id > older.id
                  )
                )
              ORDER BY newer.created_at DESC, newer.id DESC
              LIMIT 1
            ),
            older.updated_at
          )
      WHERE older.job_type = 'consolidate_memory_change'
        AND older.status IN ('pending', 'failed')
        AND EXISTS (
          SELECT 1
          FROM memory_jobs newer
          WHERE newer.job_type = 'consolidate_memory_change'
            AND newer.user_id = older.user_id
            AND newer.namespace = older.namespace
            AND json_extract(newer.payload_json, '$.memoryId') =
              json_extract(older.payload_json, '$.memoryId')
            AND newer.status IN ('pending', 'failed', 'running')
            AND (
              newer.created_at > older.created_at
              OR (
                newer.created_at = older.created_at
                AND newer.id > older.id
              )
            )
        );
      `);
      database.exec('DROP TRIGGER IF EXISTS memory_event_consolidation_job;');
      database.exec(V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER);
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
      database.exec('PRAGMA user_version = 38;');
      version = 38;
    }
    if (version < 39) {
      installV39MemoryEvidenceTriggers(database);
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
      database.exec('PRAGMA user_version = 39;');
      version = 39;
    }
    if (version < 40) {
      // 内容出生通道：pipeline = 内核提取/治理管线；api = 认证 API 直写。
      // 存量数据一律视为 pipeline（从严），备份导入同样落默认值。
      // 幂等：降版本重放迁移的测试夹具可能已含该列。
      const hasOriginColumn = database
        .prepare(
          "SELECT 1 FROM pragma_table_info('memories') WHERE name = 'origin'",
        )
        .get();
      if (!hasOriginColumn) {
        database.exec(
          "ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'pipeline';",
        );
      }
      // 迁移开头会无条件 DROP 全部会话触发器，v38/v39 块各自负责重装；
      // v40 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
      database.exec('PRAGMA user_version = 40;');
      version = 40;
    }
    if (version < 41) {
      // 可信会话签发表（服务对服务路径的部门级隔离）。
      // scopes 签发后冻结（scope 绑定不可变）；吊销置 revoked_at。
      database.exec(`
        CREATE TABLE IF NOT EXISTS trusted_sessions (
          session_id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS trusted_sessions_principal_idx
          ON trusted_sessions(principal_id, expires_at);
      `);
      // 迁移开头会无条件 DROP 全部会话触发器，v38/v39/v40 块各自重装；
      // v41 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
      database.exec('PRAGMA user_version = 41;');
      version = 41;
    }
    if (version < 42) {
      // 语料域分档（v42）：memories.corpus_domain 标注记忆所属语料域
      // （policy=制度/合同/open=开放语料/chat=对话记忆），召回重排时
      // 逐候选按域查相关性门槛。NULL = 未标注，走全局默认门槛。
      // 幂等：降版本重放迁移的测试夹具可能已含该列。
      const hasCorpusDomainColumn = database
        .prepare(
          "SELECT 1 FROM pragma_table_info('memories') WHERE name = 'corpus_domain'",
        )
        .get();
      if (!hasCorpusDomainColumn) {
        database.exec(
          'ALTER TABLE memories ADD COLUMN corpus_domain TEXT;',
        );
      }
      // 迁移开头会无条件 DROP 全部会话触发器，v38–v41 块各自重装；
      // v42 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
      database.exec('PRAGMA user_version = 42;');
      version = 42;
    }
    if (version < 43) {
      // 多租户可见性模型 v2（v43）：
      // ① 幂等键唯一约束补 scope 维度——(user_id, namespace, key) 不含 scope，
      //    同一服务账号跨部门写同名 key 会静默去重丢数据。表级 PRIMARY KEY
      //    无法 ALTER，照抄 v2 迁移模式：建新表→拷数据→换名。
      //    存量若存在"同 (user_id,namespace,key) 映射到不同 scope"的行，
      //    INSERT OR IGNORE 首行胜出——与旧行为（静默去重）语义一致，不放大丢失。
      // ② memories.classification 密级列：public/internal/confidential，
      //    NULL 与存量行一律按 internal（从严，不放大可见范围）。
      // ③ trusted_sessions.clearance：会话密级，缺省 internal。
      const idempotencyHasKeyScope = database
        .prepare(
          "SELECT 1 FROM pragma_table_info('idempotency_keys') WHERE name = 'scope_type'",
        )
        .get();
      if (!idempotencyHasKeyScope) {
        database.exec(`
          CREATE TABLE idempotency_keys_v43 (
            user_id TEXT NOT NULL,
            namespace TEXT NOT NULL,
            scope_type TEXT NOT NULL DEFAULT 'personal',
            scope_key TEXT NOT NULL DEFAULT 'self',
            key TEXT NOT NULL,
            memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, namespace, scope_type, scope_key, key)
          );
          INSERT OR IGNORE INTO idempotency_keys_v43 (
            user_id, namespace, scope_type, scope_key, key,
            memory_id, created_at
          )
          SELECT i.user_id, i.namespace,
                 COALESCE(m.scope_type, 'personal'),
                 COALESCE(m.scope_key, 'self'),
                 i.key, i.memory_id, i.created_at
          FROM idempotency_keys i
          JOIN memories m ON m.id = i.memory_id;
          DROP TABLE idempotency_keys;
          ALTER TABLE idempotency_keys_v43 RENAME TO idempotency_keys;
          CREATE INDEX idempotency_memory_idx
            ON idempotency_keys(memory_id);
        `);
      }
      const hasClassificationColumn = database
        .prepare(
          "SELECT 1 FROM pragma_table_info('memories') WHERE name = 'classification'",
        )
        .get();
      if (!hasClassificationColumn) {
        database.exec(
          "ALTER TABLE memories ADD COLUMN classification TEXT NOT NULL DEFAULT 'internal';",
        );
      }
      const hasClearanceColumn = database
        .prepare(
          "SELECT 1 FROM pragma_table_info('trusted_sessions') WHERE name = 'clearance'",
        )
        .get();
      if (!hasClearanceColumn) {
        database.exec(
          "ALTER TABLE trusted_sessions ADD COLUMN clearance TEXT NOT NULL DEFAULT 'internal';",
        );
      }
      // 迁移开头会无条件 DROP 全部会话触发器，v38–v42 块各自重装；
      // v43 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
      database.exec('PRAGMA user_version = 43;');
      version = 43;
    }
    if (version < 44) {
      // 公开通道（v44）：memories 及其派生表的 scope_type CHECK 枚举
      // 补 'public'（可见性模型 v2 的 V3 public 恒可见层依赖它）。
      rebuildScopeEnumTablesForPublicScope(database);
      // 迁移开头会无条件 DROP 全部会话触发器，v38–v43 块各自重装；
      // v44 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
      database.exec('PRAGMA user_version = 44;');
      version = 44;
    }
    assertCurrentSchemaInvariants(database);
    options.testOnlyBeforeMigrationCommit?.({
      fromVersion,
      toVersion: version,
    });
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // 事务可能已被语句级失败隐式关闭；保留原始迁移错误向上抛出
    }
    throw error;
  }
}
