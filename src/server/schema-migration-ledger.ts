/**
 * schema 迁移账本与 V26 结构证明。
 *
 * 从 database.ts 原样搬出（零逻辑改写）。
 * 账本是 fail-closed 校验的权威记录：只有 migration_key 与
 * schema_fingerprint 同时匹配当前代码，才认定库结构可信。
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY,
  V26_IDENTITY_IMMUTABILITY_SCHEMA_FINGERPRINT,
} from './schema-sql.js';

export const IDENTITY_SCHEMA_VERSION = 26;
export function hasSchemaMigrationLedger(database: DatabaseSync): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = 'schema_migration_ledger'`,
      )
      .get(),
  );
}

export function createSchemaMigrationLedger(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE schema_migration_ledger (
      schema_version INTEGER PRIMARY KEY,
      migration_key TEXT NOT NULL UNIQUE,
      from_version INTEGER NOT NULL,
      attestation_kind TEXT NOT NULL
        CHECK (attestation_kind IN (
          'migration', 'safe_no_project_adoption'
        )),
      schema_fingerprint TEXT NOT NULL,
      legacy_project_scope_count INTEGER NOT NULL
        CHECK (legacy_project_scope_count = 0),
      applied_at TEXT NOT NULL CHECK (length(trim(applied_at)) > 0),
      CHECK (
        (attestation_kind = 'migration'
          AND from_version >= 0
          AND from_version < schema_version)
        OR
        (attestation_kind = 'safe_no_project_adoption'
          AND from_version = schema_version)
      )
    );

    CREATE TRIGGER schema_migration_ledger_immutable_update
    BEFORE UPDATE ON schema_migration_ledger
    BEGIN
      SELECT RAISE(ABORT, 'schema migration ledger is immutable');
    END;

    CREATE TRIGGER schema_migration_ledger_immutable_delete
    BEFORE DELETE ON schema_migration_ledger
    BEGIN
      SELECT RAISE(ABORT, 'schema migration ledger is immutable');
    END;
  `);
}

export type V26AttestationKind = 'migration' | 'safe_no_project_adoption';
export type V26LedgerGeneration = 'v1' | 'v2';

export interface V26SchemaAttestation {
  generation: V26LedgerGeneration;
  fromVersion: number;
  attestationKind: V26AttestationKind;
}

export function recordV26CurrentSchemaAttestation(
  database: DatabaseSync,
  fromVersion: number,
  attestationKind: V26AttestationKind,
): void {
  database
    .prepare(
      `INSERT INTO schema_migration_ledger (
         schema_version,
         migration_key,
         from_version,
         attestation_kind,
         schema_fingerprint,
         legacy_project_scope_count,
         applied_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      IDENTITY_SCHEMA_VERSION,
      V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY,
      fromVersion,
      attestationKind,
      V26_IDENTITY_IMMUTABILITY_SCHEMA_FINGERPRINT,
      new Date().toISOString(),
    );
}

export function replaceV26SchemaAttestation(
  database: DatabaseSync,
  attestation: Pick<
    V26SchemaAttestation,
    'fromVersion' | 'attestationKind'
  >,
): void {
  database.exec('DROP TABLE schema_migration_ledger;');
  createSchemaMigrationLedger(database);
  recordV26CurrentSchemaAttestation(
    database,
    attestation.fromVersion,
    attestation.attestationKind,
  );
}

export function hasCurrentV26SchemaAttestation(database: DatabaseSync): boolean {
  if (!hasSchemaMigrationLedger(database)) return false;
  const attestation = database
    .prepare(
      `SELECT migration_key, schema_fingerprint
       FROM schema_migration_ledger
       WHERE schema_version = ?`,
    )
    .get(IDENTITY_SCHEMA_VERSION);
  return (
    attestation?.migration_key ===
      V26_IDENTITY_IMMUTABILITY_MIGRATION_KEY &&
    attestation?.schema_fingerprint ===
      V26_IDENTITY_IMMUTABILITY_SCHEMA_FINGERPRINT
  );
}
