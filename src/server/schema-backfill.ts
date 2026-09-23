/**
 * schema 历史数据回填与 v44 枚举重建。
 *
 * 从 database.ts 原样搬出（零逻辑改写）。这些函数只在迁移过程中调用，
 * 依赖调用方已开启事务（v44 重建还要求 defer_foreign_keys）。
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  quoteIdentifier,
} from './sqlite-schema-helpers.js';

export function backfillLegacyPrincipals(
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

export const LEGACY_SCOPE_TYPE_ENUM =
  "scope_type IN ('personal', 'project', 'role', 'session')";
export const V44_SCOPE_TYPE_ENUM =
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
export function rebuildScopeEnumTablesForPublicScope(database: DatabaseSync): void {
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
