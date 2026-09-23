/**
 * v41 · 可信会话签发表
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
export function applyV41(context: MigrationContext): void {
  const { database } = context;

  // 可信会话签发表（服务对服务路径的部门级隔离）。
  // scopes 签发后冻结（scope 绑定不可变）；吊销置 revoked_at。
  database.exec(`
        CREATE TABLE IF NOT EXISTS trusted_sessions (
          session_id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS trusted_sessions_principal_idx
          ON trusted_sessions(principal_id, expires_at);
      `);
  // 迁移开头会无条件 DROP 全部会话触发器，v38/v39/v40 块各自重装；
  // v41 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
  database.exec('PRAGMA user_version = 41;');
}
