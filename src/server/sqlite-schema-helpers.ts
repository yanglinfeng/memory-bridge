/**
 * SQLite schema 反射小工具（纯函数，数据库句柄由调用方传入）。
 *
 * 从 database.ts 原样搬出（零逻辑改写）。
 */
import type { DatabaseSync } from 'node:sqlite';

export function hasColumn(
  database: DatabaseSync,
  table: string,
  column: string,
): boolean {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<Record<string, unknown>>;
  return columns.some((entry) => entry.name === column);
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  column: string,
  statement: string,
): void {
  if (hasColumn(database, table, column)) return;
  database.exec(statement);
}
