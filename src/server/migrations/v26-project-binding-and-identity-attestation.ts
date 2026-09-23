/**
 * v26 · 会话项目绑定列、身份不可变触发器与账本首批签名
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import {
  installIdentityImmutabilityTriggers,
  assertNoLegacyProjectScopes,
  assertSchemaMigrationLedger,
} from '../schema-integrity.js';
import {
  hasSchemaMigrationLedger,
  createSchemaMigrationLedger,
  recordV26CurrentSchemaAttestation,
  replaceV26SchemaAttestation,
} from '../schema-migration-ledger.js';
import { addColumnIfMissing } from '../sqlite-schema-helpers.js';
export function applyV26(context: MigrationContext): void {
  const { database } = context;
  const { fromVersion } = context;

  assertNoLegacyProjectScopes(database);
  addColumnIfMissing(
    database,
    'conversation_sessions',
    'project_id',
    `ALTER TABLE conversation_sessions
         ADD COLUMN project_id TEXT`,
  );
  database.exec(`
      CREATE INDEX IF NOT EXISTS conversation_sessions_project_idx
        ON conversation_sessions(
          user_id,
          namespace,
          project_id,
          started_at DESC
        )
        WHERE project_id IS NOT NULL;

      PRAGMA user_version = 26;
      `);
  installIdentityImmutabilityTriggers(database);
  if (!hasSchemaMigrationLedger(database)) {
    createSchemaMigrationLedger(database);
    recordV26CurrentSchemaAttestation(
      database,
      fromVersion,
      'migration',
    );
  } else {
    const attestation = assertSchemaMigrationLedger(database, true);
    if (attestation.generation === 'v1') {
      replaceV26SchemaAttestation(database, attestation);
    }
  }
}
