/**
 * v42 · 语料域分档 corpus_domain
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
export function applyV42(context: MigrationContext): void {
  const { database } = context;

  // 语料域分档（v42）：memories.corpus_domain 标注记忆所属语料域
  // （policy=制度/合同/open=开放语料/chat=对话记忆），召回重排时
  // 逐候选按域查相关性门槛。NULL = 未标注，走全局默认门槛。
  // 幂等：降版本重放迁移的测试夹具可能已含该列。
  const hasCorpusDomainColumn = database
    .prepare(
      "SELECT 1 FROM pragma_table_info('memories') WHERE name = 'corpus_domain'",
    )
    .get();
  if (!hasCorpusDomainColumn) {
    database.exec(
      'ALTER TABLE memories ADD COLUMN corpus_domain TEXT;',
    );
  }
  // 迁移开头会无条件 DROP 全部会话触发器，v38–v41 块各自重装；
  // v42 块必须延续同一惯例，否则升级库的触发器会被删光导致断言失败。
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
  database.exec('PRAGMA user_version = 42;');
}
