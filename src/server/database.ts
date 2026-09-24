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

interface SqliteFileIdentity {
  size: number;
  mtimeMs: number;
  ino: number;
}

interface DatabaseFileFamilyIdentity {
  name: string;
  identity: SqliteFileIdentity | null;
}

interface MigrationBackup {
  created: boolean;
  backupPath: string | null;
  identity: DatabaseFileFamilyIdentity[] | null;
}

// 数据库文件家族 = 主库 + WAL + rollback journal。
// 必须连同 -wal 一起取值：WAL 模式下并发写不落主库文件（实测主库的
// size/mtime/ino 三项全不变），只把 WAL 从 0 撑大，只查主库会漏判。
// -shm 是共享内存索引、只读访问也会改写，故不纳入判据，避免误报。
function captureDatabaseFileFamily(filePath: string): DatabaseFileFamilyIdentity[] {
  return [filePath, `${filePath}-wal`, `${filePath}-journal`].map((target) => {
    try {
      const stat = fs.statSync(target);
      return {
        name: path.basename(target),
        identity: { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino },
      };
    } catch {
      return { name: path.basename(target), identity: null };
    }
  });
}

function describeFileFamilyDrift(
  before: DatabaseFileFamilyIdentity[],
  after: DatabaseFileFamilyIdentity[],
): string[] {
  const drift: string[] = [];
  for (const [index, entry] of before.entries()) {
    const then = entry.identity;
    const now = after[index]?.identity ?? null;
    if (then === null && now === null) continue;
    if (then === null || now === null) {
      drift.push(
        `${entry.name} ${then === null ? '在备份后被创建' : '在备份后被删除'}`,
      );
      continue;
    }
    if (then.ino !== now.ino) {
      drift.push(`${entry.name} 被替换（inode ${then.ino} → ${now.ino}）`);
      continue;
    }
    if (then.size !== now.size) {
      drift.push(`${entry.name} 大小 ${then.size} → ${now.size} 字节`);
      continue;
    }
    if (then.mtimeMs !== now.mtimeMs) {
      drift.push(`${entry.name} 修改时间被更新`);
    }
  }
  return drift;
}

function backupBeforeMigration(
  filePath: string,
  observedVersion: number,
): MigrationBackup {
  const skipped: MigrationBackup = {
    created: false,
    backupPath: null,
    identity: null,
  };
  if (filePath === ':memory:' || !fs.existsSync(filePath)) return skipped;
  if (
    observedVersion >= SCHEMA_VERSION ||
    fs.statSync(filePath).size === 0
  ) {
    return skipped;
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
  // 身份快照必须在 checkpoint + 复制之后取：checkpoint 自身就会改写主库与 WAL。
  // 这一刻的文件家族状态，正是 backupPath 里那份快照所对应的状态。
  return {
    created: true,
    backupPath,
    identity: captureDatabaseFileFamily(filePath),
  };
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
  // 代价是"备份完成 → 取得写锁"之间存在一个无锁窗口，该窗口内的并发写
  // 不会被写锁挡住。补偿手段是取锁后立即复检数据库文件家族的身份：
  // 一旦发现漂移就 fail-closed 拒绝迁移，绝不拿过期快照去回滚。
  const backup = backupBeforeMigration(filePath, schemaVersion(database));
  if (backup.created) options.testOnlyAfterMigrationBackup?.();

  withSqliteBusyRetry(
    () => database.exec('BEGIN IMMEDIATE'),
    {
      operation: 'acquire schema migration write lock',
      maxAttempts: 8,
      totalBudgetMs: 15_000,
    },
  );
  try {
    if (backup.identity) {
      const drift = describeFileFamilyDrift(
        backup.identity,
        captureDatabaseFileFamily(filePath),
      );
      if (drift.length > 0) {
        throw new Error(
          `检测到迁移备份之后、取得写锁之前的并发写入（${drift.join('；')}）：` +
            `快照 ${backup.backupPath} 已与数据库当前状态不一致。` +
            `为避免后续用过期快照回滚，已 fail-closed 拒绝迁移。` +
            `请在无并发写者的条件下重新打开数据库。`,
        );
      }
    }
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
