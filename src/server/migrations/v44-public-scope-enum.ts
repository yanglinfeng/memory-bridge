/**
 * v44 · 公开通道：scope_type CHECK 枚举重建
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
import { rebuildScopeEnumTablesForPublicScope } from '../schema-backfill.js';
export function applyV44(context: MigrationContext): void {
  const { database } = context;

  // 公开通道（v44）：memories 及其派生表的 scope_type CHECK 枚举
  // 补 'public'（可见性模型 v2 的 V3 public 恒可见层依赖它）。
  rebuildScopeEnumTablesForPublicScope(database);
  // 迁移开头会无条件 DROP 全部会话触发器，v38–v43 块各自重装；
  // v44 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
  database.exec('PRAGMA user_version = 44;');
}
