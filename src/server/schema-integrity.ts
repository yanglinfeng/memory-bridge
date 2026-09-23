/**
 * 库结构（schema）完整性：触发器安装与 fail-closed 结构断言。
 *
 * 从 database.ts 原样搬出（零逻辑改写）。
 * 这些函数只读校验库结构；任何一处不匹配即抛错、绝不放行，
 * 是开库/升级前的最后一道闸门。
 */
import type { DatabaseSync } from 'node:sqlite';
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
  V39_MEMORY_EVIDENCE_TRIGGERS,
} from './schema-sql.js';
import {
  IDENTITY_SCHEMA_VERSION,
  hasSchemaMigrationLedger,
  createSchemaMigrationLedger,
  recordV26CurrentSchemaAttestation,
  replaceV26SchemaAttestation,
} from './schema-migration-ledger.js';
import type {
  V26AttestationKind,
  V26SchemaAttestation,
} from './schema-migration-ledger.js';
import {
  hasColumn,
  quoteIdentifier,
} from './sqlite-schema-helpers.js';

export function installIdentityImmutabilityTriggers(
  database: DatabaseSync,
): void {
  for (const trigger of V26_IDENTITY_IMMUTABILITY_TRIGGERS) {
    database.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)}`);
    database.exec(trigger.sql);
  }
}

export function assertIdentityImmutabilityTriggers(
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

export function assertNoLegacyProjectScopes(
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

export function installV39MemoryEvidenceTriggers(
  database: DatabaseSync,
): void {
  for (const trigger of V39_MEMORY_EVIDENCE_TRIGGERS) {
    database.exec(
      `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)};`,
    );
    database.exec(trigger.sql);
  }
}

export function hasCurrentV39MemoryEvidenceTriggers(
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


export function assertSchemaMigrationLedger(
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

export function assertCurrentProjectBindingStructure(
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

export function assertRetrievalObservabilityStructure(
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

export function assertPrincipalScopedPersonaBindingStructure(
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


export function assertReflectionStructure(database: DatabaseSync): void {
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

export function assertConversationAuthorityStructure(
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

export function assertCurrentSchemaInvariants(database: DatabaseSync): void {
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

export function assertMemoryEvidenceStructure(database: DatabaseSync): void {
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

export function assertLayeredMemoryStructure(database: DatabaseSync): void {
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

export function ensureV26SchemaAttestation(database: DatabaseSync): void {
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
