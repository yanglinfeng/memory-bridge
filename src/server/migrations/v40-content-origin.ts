/**
 * v40 · 内容出生通道（pipeline / api）
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
export function applyV40(context: MigrationContext): void {
  const { database } = context;

  // 内容出生通道：pipeline = 内核提取/治理管线；api = 认证 API 直写。
  // 存量数据一律视为 pipeline（从严），备份导入同样落默认值。
  // 幂等：降版本重放迁移的测试夹具可能已含该列。
  const hasOriginColumn = database
    .prepare(
      "SELECT 1 FROM pragma_table_info('memories') WHERE name = 'origin'",
    )
    .get();
  if (!hasOriginColumn) {
    database.exec(
      "ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'pipeline';",
    );
  }
  // 迁移开头会无条件 DROP 全部会话触发器，v38/v39 块各自负责重装；
  // v40 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
  database.exec('PRAGMA user_version = 40;');
}
