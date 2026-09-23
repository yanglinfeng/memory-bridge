/**
 * v18 · 提取提示词契约版本列与回填
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV18(context: MigrationContext): void {
  const { database } = context;

  addColumnIfMissing(
    database,
    'extraction_runs',
    'prompt_contract_version',
    `ALTER TABLE extraction_runs
         ADD COLUMN prompt_contract_version TEXT NOT NULL DEFAULT 'unknown'`,
  );
  database.exec(`
      UPDATE extraction_runs
      SET prompt_contract_version = prompt_version
      WHERE prompt_contract_version = 'unknown';

      PRAGMA user_version = 18;
      `);
}
