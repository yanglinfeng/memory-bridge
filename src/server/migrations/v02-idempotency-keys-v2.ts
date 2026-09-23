/**
 * v2 · 幂等键表重建（v2）
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV2(context: MigrationContext): void {
  const { database } = context;

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
}
