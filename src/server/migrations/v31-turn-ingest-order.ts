/**
 * v31 · 轮次摄取顺序表
 *
 * 本文件由迁移注册表按版本顺序调用；调用方保证已在写事务内。
 * 迁移开头会无条件 DROP 全部会话触发器（V32/33/35/36），
 * 涉及会话触发器的版本块必须在此重装，否则升级库触发器会被删光。
 */
import type { MigrationContext } from './context.js';
import { V31_REFLECTION_TRIGGERS } from '../schema-sql.js';
export function applyV31(context: MigrationContext): void {
  const { database } = context;

  database.exec(`
      DROP TRIGGER IF EXISTS conversation_turn_ingest_order_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_owner_insert;
      DROP TRIGGER IF EXISTS memory_turn_ingest_order_identity_immutable;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_insert;
      DROP TRIGGER IF EXISTS memory_candidate_evidence_owner_update;
      DROP INDEX IF EXISTS memory_turn_ingest_owner_idx;

      ALTER TABLE memory_turn_ingest_order
        RENAME TO memory_turn_ingest_order_v30;

      CREATE TABLE memory_turn_ingest_order (
        ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL
          REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );

      INSERT INTO memory_turn_ingest_order (
        ingest_seq, turn_id, session_id, user_id, namespace, ingested_at
      )
      SELECT
        o.ingest_seq, o.turn_id, t.session_id,
        o.user_id, o.namespace, o.ingested_at
      FROM memory_turn_ingest_order_v30 o
      JOIN conversation_turns t
        ON t.id = o.turn_id
       AND t.user_id = o.user_id
       AND t.namespace = o.namespace
      JOIN conversation_sessions s
        ON s.id = t.session_id
       AND s.user_id = o.user_id
       AND s.namespace = o.namespace
      ORDER BY o.ingest_seq ASC;
      `);
  const legacyIngestCount = Number(
    database.prepare(
      'SELECT COUNT(*) AS count FROM memory_turn_ingest_order_v30',
    ).get()?.count || 0,
  );
  const migratedIngestCount = Number(
    database.prepare(
      'SELECT COUNT(*) AS count FROM memory_turn_ingest_order',
    ).get()?.count || 0,
  );
  if (legacyIngestCount !== migratedIngestCount) {
    throw new Error(
      'schema v31 ingest ledger 包含无法证明的 owner/session 绑定',
    );
  }
  database.exec(`
      DROP TABLE memory_turn_ingest_order_v30;

      CREATE INDEX memory_turn_ingest_owner_idx
        ON memory_turn_ingest_order(
          user_id, namespace, ingest_seq ASC
        );
      CREATE INDEX memory_turn_ingest_session_idx
        ON memory_turn_ingest_order(
          user_id, namespace, session_id, ingest_seq ASC
        );
      `);
  for (const trigger of V31_REFLECTION_TRIGGERS) {
    database.exec(trigger.sql);
  }
  database.exec('PRAGMA user_version = 31;');
}
