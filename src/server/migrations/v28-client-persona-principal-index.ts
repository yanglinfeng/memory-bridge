/**
 * v28 · 客户端人设主体索引
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
export function applyV28(context: MigrationContext): void {
  const { database } = context;

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
}
