import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { quoteIdentifier } from './sqlite-schema-helpers.js';
import {
  normalizeSchemaSql,
  V32_CONVERSATION_TRIGGERS,
  V33_CONVERSATION_ROUND_TRIGGERS,
  V35_CONVERSATION_REGENERATION_TRIGGERS,
  V36_CONVERSATION_DELETION_TRIGGERS,
  V37_MEMORY_EVIDENCE_TURN_INDEX,
  V38_MEMORY_EVENT_CONSOLIDATION_TRIGGER,
} from './schema-sql.js';
import { hasCurrentV26SchemaAttestation } from './schema-migration-ledger.js';
import {
  installV39MemoryEvidenceTriggers,
  hasCurrentV39MemoryEvidenceTriggers,
  assertCurrentSchemaInvariants,
  ensureV26SchemaAttestation,
} from './schema-integrity.js';
import { runMigrationSteps } from './migrations/index.js';
import { withSqliteBusyRetry } from './sqlite-retry.js';

export const SCHEMA_VERSION = 44;

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
    version = runMigrationSteps({
      database,
      fromVersion,
      version,
    });
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
