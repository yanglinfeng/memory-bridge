/**
 * v20 · 墓碑活跃条目索引
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV20(context: MigrationContext): void {
  const { database } = context;

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
}
