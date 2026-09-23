/**
 * v43 · 多租户可见性模型 v2
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import {
  V32_CONVERSATION_TRIGGERS,
  V33_CONVERSATION_ROUND_TRIGGERS,
  V35_CONVERSATION_REGENERATION_TRIGGERS,
  V36_CONVERSATION_DELETION_TRIGGERS,
} from '../schema-sql.js';
export function applyV43(context: MigrationContext): void {
  const { database } = context;

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
}
