import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TABLE_COLUMNS = Object.freeze({
  account_principals: ['id', 'status'],
  conversation_sessions: [
    'id', 'user_id', 'namespace', 'client_name', 'external_id', 'persona_id',
    'project_id', 'identity_source', 'identity_status',
  ],
  conversation_turns: [
    'id', 'session_id', 'user_id', 'namespace', 'external_id', 'role',
    'content_hash', 'round_id',
  ],
  memories: [
    'id', 'user_id', 'namespace', 'kind', 'status', 'source', 'scope_type',
    'scope_key', 'source_authority', 'semantic_revision', 'negated',
  ],
  memory_items: [
    'id', 'user_id', 'namespace', 'kind', 'current_version_id', 'status',
    'revision', 'scope_type', 'scope_key', 'source_authority', 'pinned',
  ],
  memory_versions: [
    'id', 'memory_item_id', 'version', 'namespace', 'kind', 'scope_type',
    'scope_key', 'source', 'source_authority', 'negated',
  ],
  memory_evidence: [
    'id', 'memory_version_id', 'turn_id', 'evidence_type', 'source_authority',
  ],
  memory_candidate_evidence: [
    'candidate_id', 'turn_id', 'evidence_type', 'ordinal',
  ],
  conversation_lineage_keys: [
    'session_id', 'fingerprint', 'key_type', 'message_count',
  ],
});

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeScalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('业务逻辑哈希遇到非有限数值');
    return value;
  }
  if (typeof value === 'string') return value;
  throw new Error(`业务逻辑哈希拒绝非标量字段类型：${typeof value}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalize(value[key])]));
  }
  return normalizeScalar(value);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function compareCanonical(left, right) {
  const leftJson = canonicalJson(left);
  const rightJson = canonicalJson(right);
  if (leftJson < rightJson) return -1;
  if (leftJson > rightJson) return 1;
  return 0;
}

function assertRequiredSchema(database) {
  for (const [table, expectedColumns] of Object.entries(TABLE_COLUMNS)) {
    const columns = database
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((row) => String(row.name || ''));
    if (columns.length === 0) throw new Error(`业务逻辑哈希缺少表：${table}`);
    const missing = expectedColumns.filter((column) => !columns.includes(column));
    if (missing.length > 0) {
      throw new Error(`业务逻辑哈希表 ${table} 缺少稳定字段：${missing.join(', ')}`);
    }
  }
}

function stableRows(database, table, columns, suffix = '') {
  const selected = columns.map(quoteIdentifier).join(', ');
  const rows = database.prepare(
    `SELECT ${selected} FROM ${quoteIdentifier(table)} ${suffix}`,
  ).all();
  return rows.map((row) => columns.map((column) => normalizeScalar(row[column])))
    .sort(compareCanonical);
}

function scalarCount(database, sql) {
  const row = database.prepare(sql).get();
  const value = Number(Object.values(row || {})[0] || 0);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('业务逻辑哈希计数无效');
  }
  return value;
}

function statsRows(database) {
  const rows = database.prepare(
    `SELECT user_id, status, kind, namespace, COUNT(*) AS count
       FROM memories
      GROUP BY user_id, status, kind, namespace`,
  ).all();
  return rows.map((row) => [
    normalizeScalar(row.user_id),
    normalizeScalar(row.status),
    normalizeScalar(row.kind),
    normalizeScalar(row.namespace),
    normalizeScalar(row.count),
  ]).sort(compareCanonical);
}

export function snapshotLifecycleBusinessState(databaseFile) {
  const databasePath = path.resolve(String(databaseFile || ''));
  if (!databaseFile || !fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error('--database 必须指向现有 SQLite 文件');
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    const schemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version || 0);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 31) {
      throw new Error('业务逻辑哈希要求 schema 31 或更高版本');
    }
    assertRequiredSchema(database);

    const principals = stableRows(
      database,
      'account_principals',
      TABLE_COLUMNS.account_principals,
    );
    const sessions = stableRows(
      database,
      'conversation_sessions',
      TABLE_COLUMNS.conversation_sessions,
    );
    const turns = stableRows(
      database,
      'conversation_turns',
      TABLE_COLUMNS.conversation_turns,
    );
    const memoryProjections = stableRows(
      database,
      'memories',
      TABLE_COLUMNS.memories,
    );
    const memoryItems = stableRows(
      database,
      'memory_items',
      TABLE_COLUMNS.memory_items,
    );
    const memoryVersions = stableRows(
      database,
      'memory_versions',
      TABLE_COLUMNS.memory_versions,
    );
    const evidenceEdges = stableRows(
      database,
      'memory_evidence',
      TABLE_COLUMNS.memory_evidence,
    );
    const candidateEvidenceEdges = stableRows(
      database,
      'memory_candidate_evidence',
      TABLE_COLUMNS.memory_candidate_evidence,
    );
    const lineageKeys = stableRows(
      database,
      'conversation_lineage_keys',
      TABLE_COLUMNS.conversation_lineage_keys,
    );
    const visibleMemories = stableRows(
      database,
      'memories',
      TABLE_COLUMNS.memories,
      "WHERE status != 'deleted'",
    );
    const groupedStats = statsRows(database);

    const counts = {
      principals: principals.length,
      principalNamespaces: scalarCount(
        database,
        `SELECT COUNT(*) FROM (
           SELECT user_id, namespace FROM conversation_sessions
           UNION SELECT user_id, namespace FROM memories
           UNION SELECT user_id, namespace FROM memory_items
         )`,
      ),
      sessions: sessions.length,
      turns: turns.length,
      memoryProjections: memoryProjections.length,
      memoryItems: memoryItems.length,
      memoryVersions: memoryVersions.length,
      evidenceEdges: evidenceEdges.length,
      candidateEvidenceEdges: candidateEvidenceEdges.length,
      lineageKeys: lineageKeys.length,
    };
    const hashes = {
      turns: sha256({ principals, sessions, turns }),
      memories: sha256({ memoryItems, memoryProjections, memoryVersions }),
      lineage: sha256({ candidateEvidenceEdges, evidenceEdges, lineageKeys }),
    };
    hashes.overall = sha256({ schemaVersion, ...hashes });

    return {
      format: 'memory-bridge-lifecycle-business-hash:v1',
      schemaVersion,
      counts,
      hashes,
      mcp: {
        recallList: {
          count: visibleMemories.length,
          hash: sha256(visibleMemories),
        },
        stats: {
          total: groupedStats.reduce((sum, row) => sum + Number(row[4]), 0),
          groups: groupedStats.length,
          hash: sha256(groupedStats),
        },
      },
    };
  } finally {
    database.close();
  }
}
